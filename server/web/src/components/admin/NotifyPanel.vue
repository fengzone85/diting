<script setup lang="ts">
// S1/F2：通知渠道（Webhook）+ 通知组管理面板。
// 内置 mail/telegram 渠道的凭据仍由上方「通知设置」维护，本面板只展示与开关/测试；
// Webhook 渠道在此完整增删改查。通知组按事件把渠道聚合起来。
import { ref, onMounted } from 'vue';
import { adminApi } from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import type { NotifyChannel, NotifyGroup } from '../../services/types';

const channels = ref<NotifyChannel[]>([]);
const groups = ref<NotifyGroup[]>([]);
const events = ref<string[]>([]);
const message = ref('');
const busy = ref(false);

interface ChannelEditor {
  id: number | null;
  name: string;
  url: string;
  method: 'GET' | 'POST';
  content_type: 'json' | 'form';
  headersText: string;
  body_template: string;
  verify_tls: boolean;
}
interface GroupEditor {
  id: number | null;
  name: string;
  events: string[];
  channel_ids: number[];
  enabled: boolean;
}

const channelEditor = ref<ChannelEditor | null>(null);
const groupEditor = ref<GroupEditor | null>(null);

// S2/F2：旧配置迁移横幅。检测到「旧 notify_config 凭据仍在 + default 组已接管」时提示一次；
// 关闭后记在 localStorage，避免每次进设置页都弹（判定本身幂等，无一次性状态位）。
const migration = ref<{ banner: boolean; groups_enabled: boolean } | null>(null);
const BANNER_KEY = 'diting.notify.migrationBannerDismissed';
const bannerDismissed = ref(localStorage.getItem(BANNER_KEY) === '1');

async function loadMigration() {
  try {
    migration.value = await adminApi.notifyMigrationStatus();
  } catch { /* 迁移状态拿不到不影响通知面板主流程 */ }
}

function dismissBanner() {
  bannerDismissed.value = true;
  localStorage.setItem(BANNER_KEY, '1');
}

async function load() {
  try {
    const [ch, gr, ev] = await Promise.all([
      adminApi.listNotifyChannels(),
      adminApi.listNotifyGroups(),
      adminApi.listNotifyEvents()
    ]);
    channels.value = ch;
    groups.value = gr;
    events.value = ev.events;
  } catch (e) {
    message.value = (e as Error).message || t('settings.saveFailed');
  }
  loadMigration();
}

onMounted(load);

function channelName(id: number): string {
  return channels.value.find((c) => c.id === id)?.name || `#${id}`;
}

function openNewChannel() {
  channelEditor.value = {
    id: null, name: '', url: '', method: 'POST', content_type: 'json',
    headersText: '', body_template: '', verify_tls: true
  };
}

function openEditChannel(ch: NotifyChannel) {
  const cfg = ch.config || {};
  channelEditor.value = {
    id: ch.id,
    name: ch.name,
    url: cfg.url || '',
    method: (cfg.method as 'GET' | 'POST') || 'POST',
    content_type: (cfg.content_type as 'json' | 'form') || 'json',
    headersText: Object.entries(cfg.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    body_template: cfg.body_template || '',
    verify_tls: cfg.verify_tls !== false
  };
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

async function saveChannel() {
  const e = channelEditor.value;
  if (!e) return;
  busy.value = true;
  message.value = '';
  try {
    const config = {
      url: e.url.trim(),
      method: e.method,
      content_type: e.content_type,
      headers: parseHeaders(e.headersText),
      body_template: e.body_template,
      verify_tls: e.verify_tls
    };
    if (e.id) await adminApi.updateNotifyChannel(e.id, { name: e.name.trim(), config });
    else await adminApi.createNotifyChannel({ type: 'webhook', name: e.name.trim(), config });
    channelEditor.value = null;
    await load();
    message.value = t('settings.saved');
  } catch (err) {
    message.value = (err as Error).message || t('settings.saveFailed');
  } finally {
    busy.value = false;
  }
}

async function toggleChannel(ch: NotifyChannel) {
  try {
    await adminApi.updateNotifyChannel(ch.id, { enabled: !ch.enabled });
    await load();
  } catch (e) {
    message.value = (e as Error).message || t('settings.saveFailed');
  }
}

async function testChannel(ch: NotifyChannel) {
  message.value = '';
  try {
    await adminApi.testNotifyChannel(ch.id);
    message.value = t('settings.channelTestOk', { name: ch.name });
  } catch {
    message.value = t('settings.channelTestFailed', { name: ch.name });
  }
}

async function removeChannel(ch: NotifyChannel) {
  if (!confirm(t('settings.deleteConfirm', { name: ch.name }))) return;
  try {
    await adminApi.deleteNotifyChannel(ch.id);
    await load();
  } catch (e) {
    message.value = (e as Error).message || t('settings.saveFailed');
  }
}

function openNewGroup() {
  groupEditor.value = { id: null, name: '', events: ['*'], channel_ids: [], enabled: true };
}

function openEditGroup(g: NotifyGroup) {
  groupEditor.value = {
    id: g.id, name: g.name, events: [...g.events], channel_ids: [...g.channel_ids], enabled: g.enabled
  };
}

function toggleEvent(ev: string) {
  const e = groupEditor.value;
  if (!e) return;
  e.events = e.events.includes(ev) ? e.events.filter((x) => x !== ev) : [...e.events, ev];
}

function toggleGroupChannel(id: number) {
  const e = groupEditor.value;
  if (!e) return;
  e.channel_ids = e.channel_ids.includes(id) ? e.channel_ids.filter((x) => x !== id) : [...e.channel_ids, id];
}

async function saveGroup() {
  const e = groupEditor.value;
  if (!e) return;
  busy.value = true;
  message.value = '';
  try {
    const body = { name: e.name.trim(), events: e.events, channel_ids: e.channel_ids, enabled: e.enabled };
    if (e.id) await adminApi.updateNotifyGroup(e.id, body);
    else await adminApi.createNotifyGroup(body);
    groupEditor.value = null;
    await load();
    message.value = t('settings.saved');
  } catch (err) {
    message.value = (err as Error).message || t('settings.saveFailed');
  } finally {
    busy.value = false;
  }
}

async function toggleGroup(g: NotifyGroup) {
  try {
    await adminApi.updateNotifyGroup(g.id, { enabled: !g.enabled });
    await load();
  } catch (e) {
    message.value = (e as Error).message || t('settings.saveFailed');
  }
}

async function removeGroup(g: NotifyGroup) {
  if (!confirm(t('settings.deleteConfirm', { name: g.name }))) return;
  try {
    await adminApi.deleteNotifyGroup(g.id);
    await load();
  } catch (e) {
    message.value = (e as Error).message || t('settings.saveFailed');
  }
}
</script>

<template>
  <div>
    <h2 class="mb-1 mt-8 text-lg font-semibold">{{ t('settings.notifyChannels') }}</h2>
    <p class="mb-3 text-xs text-slate-500">{{ t('settings.notifyChannelsHint') }}</p>

    <!-- S2/F2：旧配置迁移提示（关闭后不再出现） -->
    <div
      v-if="migration && migration.banner && !bannerDismissed"
      class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200"
    >
      <div class="flex items-start justify-between gap-3">
        <p class="leading-relaxed">{{ t('settings.notifyMigrationBanner') }}</p>
        <button
          type="button"
          class="shrink-0 text-amber-300/80 hover:underline"
          @click="dismissBanner"
        >{{ t('settings.notifyMigrationDismiss') }}</button>
      </div>
      <p v-if="migration && !migration.groups_enabled" class="mt-2 leading-relaxed text-amber-300/90">
        {{ t('settings.notifyGroupsDisabledHint') }}
      </p>
    </div>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="rounded-lg bg-sky-500 px-3 py-1.5 text-sm text-white hover:bg-sky-400"
        @click="openNewChannel"
      >{{ t('settings.addWebhook') }}</button>
      <span v-if="message" class="text-xs text-slate-400">{{ message }}</span>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="text-xs text-slate-500">
          <tr>
            <th class="py-2">{{ t('settings.channelName') }}</th>
            <th class="py-2">{{ t('settings.channelType') }}</th>
            <th class="py-2">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ch in channels" :key="ch.id" class="border-t border-slate-800">
            <td class="py-2 pr-3">
              {{ ch.name }}
              <span v-if="!ch.enabled" class="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">{{ t('settings.disabled') }}</span>
            </td>
            <td class="py-2 pr-3 text-xs text-slate-400">
              {{ ch.type }}
              <span v-if="ch.type !== 'webhook'" class="ml-1 text-slate-500">({{ t('settings.builtinChannel') }})</span>
            </td>
            <td class="py-2">
              <div class="flex flex-wrap gap-2 text-xs">
                <button type="button" class="text-sky-400 hover:underline" @click="testChannel(ch)">{{ t('settings.test') }}</button>
                <button type="button" class="text-slate-300 hover:underline" @click="toggleChannel(ch)">
                  {{ ch.enabled ? t('settings.disable') : t('settings.enable') }}
                </button>
                <template v-if="ch.type === 'webhook'">
                  <button type="button" class="text-violet-400 hover:underline" @click="openEditChannel(ch)">{{ t('common.edit') }}</button>
                  <button type="button" class="text-rose-400 hover:underline" @click="removeChannel(ch)">{{ t('common.delete') }}</button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <h2 class="mb-1 mt-8 text-lg font-semibold">{{ t('settings.notifyGroups') }}</h2>
    <p class="mb-3 text-xs text-slate-500">{{ t('settings.notifyGroupsHint') }}</p>

    <div class="mb-3">
      <button
        type="button"
        class="rounded-lg bg-sky-500 px-3 py-1.5 text-sm text-white hover:bg-sky-400"
        @click="openNewGroup"
      >{{ t('settings.addGroup') }}</button>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="text-xs text-slate-500">
          <tr>
            <th class="py-2">{{ t('settings.groupName') }}</th>
            <th class="py-2">{{ t('settings.groupEvents') }}</th>
            <th class="py-2">{{ t('settings.groupChannels') }}</th>
            <th class="py-2">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in groups" :key="g.id" class="border-t border-slate-800">
            <td class="py-2 pr-3">
              {{ g.name }}
              <span v-if="!g.enabled" class="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">{{ t('settings.disabled') }}</span>
            </td>
            <td class="py-2 pr-3 text-xs text-slate-400">{{ g.events.join(', ') || '—' }}</td>
            <td class="py-2 pr-3 text-xs text-slate-400">{{ g.channel_ids.map(channelName).join(', ') || '—' }}</td>
            <td class="py-2">
              <div class="flex flex-wrap gap-2 text-xs">
                <button type="button" class="text-violet-400 hover:underline" @click="openEditGroup(g)">{{ t('common.edit') }}</button>
                <button type="button" class="text-slate-300 hover:underline" @click="toggleGroup(g)">
                  {{ g.enabled ? t('settings.disable') : t('settings.enable') }}
                </button>
                <button type="button" class="text-rose-400 hover:underline" @click="removeGroup(g)">{{ t('common.delete') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Webhook 渠道编辑弹窗 -->
    <div v-if="channelEditor" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="channelEditor = null">
      <div class="glass w-full max-w-xl p-5">
        <h3 class="mb-4 text-lg font-semibold">
          {{ channelEditor.id ? t('settings.editWebhook') : t('settings.addWebhook') }}
        </h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class="text-xs text-slate-400">
            {{ t('settings.channelName') }}
            <input v-model="channelEditor.name" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white" />
          </label>
          <label class="text-xs text-slate-400">
            {{ t('settings.webhookMethod') }}
            <select v-model="channelEditor.method" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white">
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </select>
          </label>
          <label class="text-xs text-slate-400 sm:col-span-2">
            {{ t('settings.webhookUrl') }}
            <input v-model="channelEditor.url" placeholder="https://example.com/hook" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white" />
          </label>
          <label class="text-xs text-slate-400">
            {{ t('settings.webhookContentType') }}
            <select v-model="channelEditor.content_type" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white">
              <option value="json">application/json</option>
              <option value="form">application/x-www-form-urlencoded</option>
            </select>
          </label>
          <label class="flex items-end gap-2 pb-2 text-sm text-slate-300">
            <input v-model="channelEditor.verify_tls" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-800" />
            {{ t('settings.verifyTls') }}
          </label>
          <label class="text-xs text-slate-400 sm:col-span-2">
            {{ t('settings.webhookHeaders') }}
            <textarea v-model="channelEditor.headersText" rows="3" :placeholder="t('settings.webhookHeadersHint')" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 font-mono text-xs text-white" />
          </label>
          <label class="text-xs text-slate-400 sm:col-span-2">
            {{ t('settings.webhookBody') }}
            <textarea v-model="channelEditor.body_template" rows="3" :placeholder="t('settings.webhookBodyHint')" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 font-mono text-xs text-white" />
          </label>
        </div>
        <p class="mt-3 text-[11px] leading-relaxed text-slate-500">{{ t('settings.webhookPlaceholderHint') }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800" @click="channelEditor = null">{{ t('common.cancel') }}</button>
          <button type="button" class="rounded-lg bg-sky-500 px-4 py-2 text-sm text-white hover:bg-sky-400 disabled:opacity-50" :disabled="busy" @click="saveChannel">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>

    <!-- 通知组编辑弹窗 -->
    <div v-if="groupEditor" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="groupEditor = null">
      <div class="glass w-full max-w-xl p-5">
        <h3 class="mb-4 text-lg font-semibold">
          {{ groupEditor.id ? t('settings.editGroup') : t('settings.addGroup') }}
        </h3>
        <label class="text-xs text-slate-400">
          {{ t('settings.groupName') }}
          <input v-model="groupEditor.name" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white" />
        </label>
        <div class="mt-4">
          <p class="mb-2 text-xs text-slate-400">{{ t('settings.groupEvents') }}</p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="ev in events"
              :key="ev"
              type="button"
              class="rounded-full border px-2.5 py-1 text-xs"
              :class="groupEditor.events.includes(ev)
                ? 'border-sky-400 bg-sky-500/20 text-sky-300'
                : 'border-slate-700 text-slate-400 hover:border-slate-500'"
              @click="toggleEvent(ev)"
            >{{ ev }}</button>
          </div>
        </div>
        <div class="mt-4">
          <p class="mb-2 text-xs text-slate-400">{{ t('settings.groupChannels') }}</p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="ch in channels"
              :key="ch.id"
              type="button"
              class="rounded-full border px-2.5 py-1 text-xs"
              :class="groupEditor.channel_ids.includes(ch.id)
                ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300'
                : 'border-slate-700 text-slate-400 hover:border-slate-500'"
              @click="toggleGroupChannel(ch.id)"
            >{{ ch.name }}</button>
          </div>
        </div>
        <label class="mt-4 flex cursor-pointer items-center gap-2 text-sm text-slate-300">
          <input v-model="groupEditor.enabled" type="checkbox" class="h-4 w-4 rounded border-slate-600 bg-slate-800" />
          {{ t('settings.enable') }}
        </label>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800" @click="groupEditor = null">{{ t('common.cancel') }}</button>
          <button type="button" class="rounded-lg bg-sky-500 px-4 py-2 text-sm text-white hover:bg-sky-400 disabled:opacity-50" :disabled="busy" @click="saveGroup">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
