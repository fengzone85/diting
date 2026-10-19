package config

import "testing"

func setRequiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("SERVER_URL", "https://example.com")
	t.Setenv("AGENT_ID", "agt_test")
	t.Setenv("AGENT_TOKEN", "token")
}

func TestLoadMonthRotatePrimaryAndAlias(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("MONTH_ROTATE", "15")
	t.Setenv("AGENT_MONTH_ROTATE", "7")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.MonthRotate != 15 {
		t.Fatalf("MONTH_ROTATE should win: got %d", cfg.MonthRotate)
	}

	t.Setenv("MONTH_ROTATE", "")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.MonthRotate != 7 {
		t.Fatalf("AGENT_MONTH_ROTATE alias should be used: got %d", cfg.MonthRotate)
	}
}

func TestLoadMonthRotateInvalidFallsBackToZero(t *testing.T) {
	setRequiredEnv(t)
	for _, value := range []string{"32", "-1", "abc"} {
		t.Setenv("MONTH_ROTATE", value)
		t.Setenv("AGENT_MONTH_ROTATE", "")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.MonthRotate != 0 {
			t.Fatalf("invalid MONTH_ROTATE %q should fall back to 0: got %d", value, cfg.MonthRotate)
		}
	}
}
