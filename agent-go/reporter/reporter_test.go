package reporter

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// newTestReporter 用 httptest 起一个可控服务端，并把退避压到毫秒级。
// 生产默认 10 分钟的 401/403 退避若不注入，验证这条分支就要真等 10 分钟。
func newTestReporter(t *testing.T, interval time.Duration, handler http.HandlerFunc) (*Reporter, *int32) {
	t.Helper()
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		handler(w, r)
	}))
	t.Cleanup(srv.Close)

	r := NewReporter(srv.URL, "agent-1", "tok-1", interval, "test")
	r.authBackoff = time.Millisecond
	return r, &hits
}

func TestReportSuccess(t *testing.T) {
	r, hits := newTestReporter(t, time.Millisecond, func(w http.ResponseWriter, req *http.Request) {
		if got, want := req.URL.Path, "/api/report"; got != want {
			t.Errorf("path = %q, want %q", got, want)
		}
		if got, want := req.Method, http.MethodPost; got != want {
			t.Errorf("method = %q, want %q", got, want)
		}
		if got, want := req.Header.Get("Authorization"), "Bearer tok-1"; got != want {
			t.Errorf("Authorization = %q, want %q", got, want)
		}
		if got, want := req.Header.Get("X-Agent-ID"), "agent-1"; got != want {
			t.Errorf("X-Agent-ID = %q, want %q", got, want)
		}
		if got, want := req.Header.Get("User-Agent"), "diting-agent-go/test"; got != want {
			t.Errorf("User-Agent = %q, want %q", got, want)
		}
		if got, want := req.Header.Get("Content-Type"), "application/json"; got != want {
			t.Errorf("Content-Type = %q, want %q", got, want)
		}
		w.WriteHeader(http.StatusOK)
	})

	if err := r.Report(context.Background(), []byte(`{"cpu":1}`)); err != nil {
		t.Fatalf("Report() = %v, want nil", err)
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Fatalf("hits = %d, want 1", got)
	}
}

func TestReportRetriesThenSucceeds(t *testing.T) {
	var n int32
	r, hits := newTestReporter(t, time.Millisecond, func(w http.ResponseWriter, req *http.Request) {
		if atomic.AddInt32(&n, 1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	if err := r.Report(context.Background(), []byte("{}")); err != nil {
		t.Fatalf("Report() = %v, want nil（第二次应成功）", err)
	}
	if got := atomic.LoadInt32(hits); got != 2 {
		t.Fatalf("hits = %d, want 2", got)
	}
}

func TestReportExhaustsRetries(t *testing.T) {
	r, hits := newTestReporter(t, time.Millisecond, func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	err := r.Report(context.Background(), []byte("{}"))
	if err == nil {
		t.Fatal("Report() = nil, want error")
	}
	if got, want := err.Error(), "status 500"; got != want {
		t.Fatalf("err = %q, want %q", got, want)
	}
	// attempt 0..3：首轮 + 3 次重试
	if got := atomic.LoadInt32(hits); got != 4 {
		t.Fatalf("hits = %d, want 4", got)
	}
}

func TestReportAuthRejectedDoesNotRetry(t *testing.T) {
	for _, code := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			r, hits := newTestReporter(t, time.Millisecond, func(w http.ResponseWriter, req *http.Request) {
				w.WriteHeader(code)
			})

			start := time.Now()
			err := r.Report(context.Background(), []byte("{}"))
			if !errors.Is(err, errAuthRejected) {
				t.Fatalf("Report() = %v, want errAuthRejected", err)
			}
			if got := atomic.LoadInt32(hits); got != 1 {
				t.Fatalf("hits = %d, want 1（401/403 不重试）", got)
			}
			if elapsed := time.Since(start); elapsed > time.Second {
				t.Fatalf("退避未生效或未注入：耗时 %s", elapsed)
			}
		})
	}
}

func TestReportCanceledDuringRetryBackoff(t *testing.T) {
	// interval 1s ⇒ 首次重试退避 2s；ctx 30ms 到期时必须立刻返回。
	r, _ := newTestReporter(t, time.Second, func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	err := r.Report(ctx, []byte("{}"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Report() = %v, want context.DeadlineExceeded", err)
	}
}

func TestReportCanceledDuringAuthBackoff(t *testing.T) {
	r, hits := newTestReporter(t, time.Millisecond, func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	r.authBackoff = time.Hour // 只能靠 ctx 打断

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	err := r.Report(ctx, []byte("{}"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Report() = %v, want context.DeadlineExceeded", err)
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Fatalf("hits = %d, want 1", got)
	}
}
