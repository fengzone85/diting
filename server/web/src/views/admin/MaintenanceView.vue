<script setup lang="ts">
// 系统维护：数据保留 / 数据库备份与恢复 / 容量保险丝。
// 从原 864 行「设置」万物桶中拆出（后台信息架构重组）。
// 二级导航对齐参考面板：五个分节是 /admin/maintenance/* 子路由，侧栏父子菜单承载；
// 同一组件实例跨子路由复用（useSettingsForm/useBackupPanel 状态不丢），props.section 选定渲染分节。
import { t } from '../../composables/useI18n';
import { useSettingsForm } from '../../composables/useSettingsForm';
import { useBackupPanel } from '../../composables/useBackupPanel';
import FormInput from '../../components/ui/FormInput.vue';
import PageShell from '../../components/admin/PageShell.vue';

defineProps<{ section: string }>();

const { local, saving, message, ready, save } = useSettingsForm();

// ---- 备份 / 恢复审查 / 容量：逻辑集中在 useBackupPanel，模板变量名保持不变 ----
const {
  backupState, backupFiles, backupDir, backupAvailable, backupBusy, backupMsg,
  restoreAudit, capacityStatus, capacityBusy, capacityMsg,
  backupFileInput, backupUploading, backupUploadPct,
  loadBackups, cleanupCapacity, downloadBackup, removeBackup, onPickBackup, createSnapshot, restoreBackup,
  fmtBytes, fmtTime, backupStatusText, backupStale,
  restoreCheckName, restoreStatusName, restoreStatusClass, restoreCheckText, restoreRetention,
  integrityClass, integrityText,
} = useBackupPanel();
</script>

<template>
  <PageShell :title="t('maintenance.title')">
    <template #actions>
      <button
        :disabled="saving || !ready"
        class="rounded-lg bg-sky-500 px-5 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50"
        @click="save"
      >
        {{ saving ? t('settings.saving') : t('common.save') }}
      </button>
    </template>

    <template v-if="message" #banner>
      <div class="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 p-2.5 text-sm text-sky-200">
        {{ message }}
      </div>
    </template>

    <div class="space-y-4">
    <section v-show="section === 'sec-retention'" id="sec-retention" class="glass rounded-xl p-5">
      <h2 class="mb-1 text-lg font-semibold">{{ t('settings.retentionTitle') }}</h2>
      <p class="mb-4 text-xs text-muted">{{ t('settings.retentionHint') }}</p>
      <div class="grid gap-x-6 sm:grid-cols-3">
        <FormInput v-model="local.ui.retention_days" :label="t('settings.retentionDays')" type="number" />
      </div>
    </section>

    <!-- 数据库备份：策略由本页下发，实际执行在宿主机（diting.sh + cron） -->
    <section v-show="section === 'sec-backup'" id="sec-backup" class="glass rounded-xl p-5">
      <h2 class="mb-1 text-lg font-semibold">{{ t('settings.backup') }}</h2>
      <p class="mb-4 text-xs text-muted">{{ t('settings.backupHint') }}</p>

      <div class="grid grid-cols-1 gap-x-6 md:grid-cols-2">
        <div>
          <label class="mb-1 block text-sm text-secondary">{{ t('settings.backupSchedule') }}</label>
          <select
            v-model="local.ui.backup_schedule"
            class="field-control mb-3 w-full"
          >
            <option value="off">{{ t('settings.backupScheduleOff') }}</option>
            <option value="daily">{{ t('settings.backupScheduleDaily') }}</option>
            <option value="weekly">{{ t('settings.backupScheduleWeekly') }}</option>
          </select>

          <FormInput
            v-model="local.ui.backup_hour"
            :label="t('settings.backupHour')"
            type="number"
            :hint="t('settings.backupHourHint')"
          />
          <FormInput
            v-model="local.ui.backup_keep_days"
            :label="t('settings.backupKeepDays')"
            type="number"
            :hint="t('settings.backupKeepDaysHint')"
          />
          <FormInput
            v-model="local.ui.backup_keep_count"
            :label="t('settings.backupKeepCount')"
            type="number"
            :hint="t('settings.backupKeepCountHint')"
          />
          <FormInput
            v-model="local.ui.backup_compress"
            :label="t('settings.backupCompress')"
            type="checkbox"
            :hint="t('settings.backupCompressHint')"
          />
        </div>

        <div class="inner-panel p-4 text-sm">
          <h3 class="mb-3 font-semibold">{{ t('settings.backupMonitor') }}</h3>
          <div v-if="!backupState" class="text-muted">{{ t('settings.backupNoState') }}</div>
          <dl v-else class="space-y-2">
            <div class="flex justify-between gap-4">
              <dt class="text-muted">{{ t('settings.backupLastRun') }}</dt>
              <dd class="text-right">{{ fmtTime(backupState.last_run_ts) }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">{{ t('settings.backupResult') }}</dt>
              <dd class="text-right">
                <span :class="backupState.last_status === 'ok' ? 'text-emerald-400' : 'text-amber-400'">
                  {{ backupStatusText }}
                </span>
                <span v-if="backupStale" class="ml-2 text-amber-400">{{ t('settings.backupStale') }}</span>
              </dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">{{ t('settings.backupFile') }}</dt>
              <dd class="break-all text-right">{{ backupState.last_file || '-' }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">{{ t('settings.backupSize') }}</dt>
              <dd class="text-right">{{ fmtBytes(backupState.last_size_bytes) }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">{{ t('settings.backupTotal') }}</dt>
              <dd class="text-right">
                {{ fmtBytes(backupState.total_bytes) }}
                <span class="text-muted">({{ backupState.backup_count ?? 0 }})</span>
              </dd>
            </div>
            <div v-if="backupState.last_error" class="text-amber-400">
              {{ backupState.last_error }}
            </div>
          </dl>
        </div>
      </div>

    </section>

    <!-- F8.6：最近一次恢复审查（恢复后服务端启动时生成，只读） -->
    <section v-show="section === 'sec-restore'" id="sec-restore" class="glass rounded-xl p-5">
      <h2 class="mb-1 text-lg font-semibold">{{ t('settings.restoreAuditTitle') }}</h2>
      <p class="mb-3 text-xs text-muted">{{ t('settings.restoreAuditHint') }}</p>
        <div v-if="!restoreAudit" class="text-sm text-muted">{{ t('settings.restoreAuditNone') }}</div>
        <template v-else>
          <dl class="mb-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div class="flex justify-between gap-4">
              <dt class="text-muted">{{ t('settings.restoreAuditTime') }}</dt>
              <dd class="text-right">{{ fmtTime(restoreAudit.ts) }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">{{ t('settings.restoreAuditFrom') }}</dt>
              <dd class="break-all text-right">{{ restoreAudit.backup?.name || '-' }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">{{ t('settings.restoreAuditBy') }}</dt>
              <dd class="break-all text-right">{{ restoreAudit.backup?.by || '-' }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-muted">{{ t('settings.restoreAuditDuration') }}</dt>
              <dd class="text-right">{{ restoreAudit.duration_ms }} ms</dd>
            </div>
          </dl>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="text-xs text-muted">
                <tr>
                  <th class="py-2 pr-4">{{ t('settings.restoreAuditCheck') }}</th>
                  <th class="py-2 pr-4">{{ t('settings.restoreAuditStatus') }}</th>
                  <th class="py-2">{{ t('settings.restoreAuditDetail') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in restoreAudit.checks || []" :key="c.id" class="border-t border-divider">
                  <td class="py-2 pr-4 whitespace-nowrap">{{ restoreCheckName(c) }}</td>
                  <td class="py-2 pr-4 whitespace-nowrap" :class="restoreStatusClass(c.status)">
                    {{ restoreStatusName(c) }}
                  </td>
                  <td class="py-2 break-all text-secondary">{{ restoreCheckText(c) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="restoreRetention" class="mt-3 rounded border border-divider p-2 text-xs">
            <div class="text-muted">
              {{ t('settings.restoreAuditExpiredRange', {
                from: fmtTime(restoreRetention.earliest),
                to: fmtTime(restoreRetention.latest),
              }) }}
            </div>
            <div v-for="(b, i) in restoreRetention.buckets" :key="i" class="mt-1 text-muted">
              {{ t('settings.restoreAuditBatch', {
                n: i + 1,
                from: fmtTime(b.from_ts),
                to: fmtTime(b.to_ts),
                rows: b.rows,
              }) }}
            </div>
            <div v-if="restoreRetention.truncated" class="mt-1 opacity-50">
              {{ t('settings.restoreAuditBatchTruncated') }}
            </div>
          </div>
          <p class="mt-3 text-xs text-muted">
            {{ t('settings.restoreAuditSummary', {
              expired: restoreAudit.summary?.expired_rows ?? 0,
              total: restoreAudit.summary?.total_rows ?? 0,
              orphans: restoreAudit.summary?.orphan_deleted ?? 0,
              purged: restoreAudit.summary?.purged_agents ?? 0,
            }) }}
          </p>
        </template>
    </section>

    <!-- 备份文件列表：下载 / 恢复 / 删除 -->
    <section v-show="section === 'sec-files'" id="sec-files" class="glass rounded-xl p-5">
      <div class="mb-3 flex flex-wrap items-center gap-3">
          <h2 class="text-lg font-semibold">{{ t('settings.backupFiles') }}</h2>
          <span v-if="backupDir" class="text-xs text-muted">{{ backupDir }}</span>
          <button
            class="btn-ghost px-3 py-1 text-xs"
            @click="loadBackups"
          >
            {{ t('common.refresh') }}
          </button>
        </div>

        <!-- F8.1：应用内快照（在线备份，不需要停服） -->
        <div class="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <button
            :disabled="!!backupBusy || backupUploading"
            class="rounded border border-emerald-400/40 px-3 py-1 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
            @click="createSnapshot"
          >
            {{ backupBusy === 'create' ? t('settings.backupCreating') : t('settings.backupCreateNow') }}
          </button>
          <span class="text-muted">{{ t('settings.backupCreateHint') }}</span>
        </div>

        <!-- 上传外部备份：服务端只认 SQLite / gzip，文件名由服务端生成 -->
        <div class="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <input ref="backupFileInput" type="file" accept=".db,.gz" class="hidden" @change="onPickBackup" />
          <button
            :disabled="backupUploading"
            class="btn-ghost px-3 py-1"
            @click="backupFileInput?.click()"
          >
            {{ backupUploading ? `${t('settings.backupUploading')} ${backupUploadPct}%` : t('settings.backupUpload') }}
          </button>
          <span class="text-muted">{{ t('settings.backupUploadHint') }}</span>
        </div>

        <div v-if="backupMsg" class="mb-3 rounded border border-sky-500/30 bg-sky-500/10 p-2 text-xs text-sky-200">
          {{ backupMsg }}
        </div>

        <div v-if="!backupAvailable" class="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          {{ t('settings.backupDirUnavailable') }}
        </div>
        <div v-else-if="!backupFiles.length" class="p-3 text-sm text-muted">
          {{ t('settings.backupNoFiles') }}
        </div>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="text-xs text-muted">
              <tr>
                <th class="py-2 pr-4">{{ t('settings.backupFile') }}</th>
                <th class="py-2 pr-4">{{ t('settings.backupTime') }}</th>
                <th class="py-2 pr-4">{{ t('settings.backupSize') }}</th>
                <th class="py-2 pr-4">{{ t('settings.backupIntegrity') }}</th>
                <th class="py-2 text-right">{{ t('common.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in backupFiles" :key="f.name" class="border-t border-divider">
                <td class="py-2 pr-4 break-all">
                  {{ f.name }}
                  <span v-if="f.kind === 'pre_restore'" class="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-300">
                    {{ t('settings.backupKindPreRestore') }}
                  </span>
                </td>
                <td class="py-2 pr-4 whitespace-nowrap">{{ fmtTime(f.mtime) }}</td>
                <td class="py-2 pr-4 whitespace-nowrap">{{ fmtBytes(f.size_bytes) }}</td>
                <td class="py-2 pr-4 whitespace-nowrap" :class="integrityClass(f.integrity)" :title="f.integrity_reason || ''">
                  {{ integrityText(f.integrity) }}
                </td>
                <td class="py-2 text-right whitespace-nowrap">
                  <button
                    class="btn-ghost mr-2 px-2 py-1 text-xs"
                    @click="downloadBackup(f)"
                  >
                    {{ t('settings.backupDownload') }}
                  </button>
                  <button
                    :disabled="backupBusy === f.name"
                    class="mr-2 rounded border border-sky-500/40 px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
                    @click="restoreBackup(f)"
                  >
                    {{ t('settings.backupRestore') }}
                  </button>
                  <button
                    :disabled="backupBusy === f.name"
                    class="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                    @click="removeBackup(f)"
                  >
                    {{ t('settings.backupDelete') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="mt-3 text-xs text-muted">{{ t('settings.backupRestoreHint') }}</p>
        </div>
    </section>

    <!-- F12：容量保险丝（metrics 行数 + 库文件双水位） -->
    <section v-show="section === 'sec-capacity'" id="sec-capacity" class="glass rounded-xl p-5">
      <h2 class="mb-1 text-lg font-semibold">{{ t('settings.capacityTitle') }}</h2>
      <p class="mb-4 text-xs text-muted">{{ t('settings.capacityHint') }}</p>

      <div v-if="capacityStatus" class="inner-panel mb-4 p-3 text-sm">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span
            class="rounded px-2 py-0.5 text-xs"
            :class="capacityStatus.level === 'full'
              ? 'bg-rose-500/20 text-rose-300'
              : capacityStatus.level === 'warn'
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-emerald-500/20 text-emerald-300'"
          >
            {{ t(`settings.capacityLevel_${capacityStatus.level}`) }}
          </span>
          <span v-if="capacityStatus.paused" class="text-xs text-rose-300">{{ t('settings.capacityPaused') }}</span>
        </div>
        <div class="grid grid-cols-1 gap-1 text-xs text-secondary sm:grid-cols-2">
          <div>
            {{ t('settings.capacityRowsValue', {
              rows: capacityStatus.rows,
              max: capacityStatus.max_rows,
              pct: Math.round(capacityStatus.row_pct * 100),
            }) }}
          </div>
          <div>
            {{ t('settings.capacityBytesValue', {
              cur: fmtBytes(capacityStatus.bytes),
              max: fmtBytes(capacityStatus.max_bytes),
              pct: Math.round(capacityStatus.byte_pct * 100),
            }) }}
          </div>
        </div>
        <div v-if="capacityStatus.skipped" class="mt-1 text-xs text-amber-300">
          {{ t('settings.capacitySkipped', { n: capacityStatus.skipped }) }}
        </div>
      </div>

      <div class="grid grid-cols-1 gap-x-6 md:grid-cols-2">
        <div>
          <FormInput v-model="local.ui.capacity_enabled" :label="t('settings.capacityEnabled')" type="checkbox" />
          <FormInput
            v-model="local.ui.capacity_max_rows"
            :label="t('settings.capacityMaxRows')"
            type="number"
            :hint="t('settings.capacityMaxRowsHint')"
          />
          <FormInput
            v-model="local.ui.capacity_max_mb"
            :label="t('settings.capacityMaxMb')"
            type="number"
            :hint="t('settings.capacityMaxMbHint')"
          />
        </div>
        <div class="flex flex-col justify-end gap-2">
          <button
            :disabled="capacityBusy"
            class="self-start rounded border border-amber-400/40 px-3 py-1 text-xs text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
            @click="cleanupCapacity"
          >
            {{ capacityBusy ? t('settings.capacityCleaning') : t('settings.capacityCleanup') }}
          </button>
          <p class="text-xs text-muted">{{ t('settings.capacityCleanupHint') }}</p>
          <p v-if="capacityMsg" class="text-xs text-sky-300">{{ capacityMsg }}</p>
        </div>
      </div>
    </section>
    </div>
  </PageShell>
</template>
