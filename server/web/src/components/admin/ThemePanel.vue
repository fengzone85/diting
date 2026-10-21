<script setup lang="ts">
// S5/F10：主题市场面板（已安装 / 市场 / 来源）。
// 独立组件避免 SettingsView 继续膨胀；启用/删除后向父组件发 changed 以刷新主题下拉。
import { ref, onMounted } from 'vue';
import { adminApi } from '../../services/adminApi';
import type {
  ThemeInfo, ThemeSource, ThemeCatalog, ThemeBackup, ThemeConfigField
} from '../../services/adminApi';
import { t } from '../../composables/useI18n';
import { themeErrorMessage } from '../../utils/themeError';

const emit = defineEmits<{ (e: 'changed'): void }>();

type Tab = 'installed' | 'market';
type ConfigValues = Record<string, string | number | boolean>;

const tab = ref<Tab>('installed');
const TABS: Tab[] = ['installed', 'market'];
const sourceDialog = ref(false);
const installed = ref<ThemeInfo[]>([]);
const sources = ref<ThemeSource[]>([]);
const catalog = ref<ThemeCatalog | null>(null);
const backups = ref<ThemeBackup[] | null>(null);
const backupsFor = ref('');
const backupsName = ref('');
const message = ref('');
const error = ref('');
const busy = ref('');

const newSource = ref({ name: '', url: '' });
const importUrl = ref('');
const importPreview = ref<ThemeInfo | null>(null);

const configEditor = ref<{
  theme: string;
  name: string;
  fields: ThemeConfigField[];
  values: ConfigValues;
} | null>(null);

function reportError(e: unknown) {
  error.value = themeErrorMessage(e);
  message.value = '';
}
function reportOk(msg: string) {
  message.value = msg;
  error.value = '';
}

async function loadInstalled() {
  try {
    installed.value = await adminApi.listInstalledThemes();
  } catch (e) { reportError(e); }
}
async function loadSources() {
  try {
    sources.value = await adminApi.listThemeSources();
  } catch (e) { reportError(e); }
}
async function loadCatalog(refresh = false) {
  busy.value = refresh ? 'catalog' : '';
  error.value = '';
  try {
    catalog.value = await adminApi.themeCatalog(refresh);
  } catch (e) { reportError(e); }
  busy.value = '';
}

onMounted(() => {
  void loadInstalled();
  void loadSources();
});

function switchTab(next: Tab) {
  tab.value = next;
  error.value = '';
  if (next === 'market' && !catalog.value) void loadCatalog();
}

function tabKey(item: Tab) {
  if (item === 'installed') return t('theme.tabInstalled');
  return t('theme.tabMarket');
}

function isInstalled(short: string) {
  return installed.value.some((x) => x.short === short);
}

async function enableTheme(item: ThemeInfo) {
  busy.value = `set:${item.short}`;
  try {
    await adminApi.setTheme(item.short);
    await loadInstalled();
    emit('changed');
    reportOk(t('theme.enabledOk', { name: item.name }));
  } catch (e) { reportError(e); }
  busy.value = '';
}

async function removeTheme(item: ThemeInfo) {
  if (!window.confirm(t('theme.deleteConfirm', { name: item.name }))) return;
  busy.value = `delete:${item.short}`;
  try {
    await adminApi.deleteTheme(item.short);
    await loadInstalled();
    emit('changed');
    reportOk(t('theme.deletedOk', { name: item.name }));
  } catch (e) { reportError(e); }
  busy.value = '';
}

async function updateTheme(item: ThemeInfo) {
  if (!window.confirm(t('theme.updateConfirm', { name: item.name }))) return;
  busy.value = `update:${item.short}`;
  try {
    await adminApi.updateTheme(item.short);
    await loadInstalled();
    reportOk(t('theme.updatedOk', { name: item.name }));
  } catch (e) { reportError(e); }
  busy.value = '';
}

async function openBackups(item: ThemeInfo) {
  backupsFor.value = item.short;
  backupsName.value = item.name;
  try {
    backups.value = await adminApi.listThemeBackups(item.short);
  } catch (e) { reportError(e); }
}

async function rollback(backup: ThemeBackup) {
  if (!window.confirm(t('theme.rollbackConfirm', {
    name: backupsName.value, time: new Date(backup.created_at).toLocaleString()
  }))) return;
  busy.value = `rollback:${backupsFor.value}`;
  try {
    await adminApi.rollbackTheme(backupsFor.value, backup.name);
    backups.value = null;
    await loadInstalled();
    reportOk(t('theme.rolledBack', { name: backupsName.value }));
  } catch (e) { reportError(e); }
  busy.value = '';
}

async function openConfig(item: ThemeInfo) {
  try {
    const res = await adminApi.getThemeConfig(item.short);
    const values: ConfigValues = {};
    for (const f of res.configuration.fields) {
      const v = res.values[f.key];
      values[f.key] = (v === undefined || v === null) ? (f.default as ConfigValues[string] ?? '') : (v as ConfigValues[string]);
    }
    configEditor.value = { theme: item.short, name: item.name, fields: res.configuration.fields, values };
  } catch (e) { reportError(e); }
}

async function saveConfig() {
  const editor = configEditor.value;
  if (!editor) return;
  busy.value = `config:${editor.theme}`;
  try {
    await adminApi.saveThemeConfig(editor.theme, editor.values);
    configEditor.value = null;
    reportOk(t('theme.configSaved'));
  } catch (e) { reportError(e); }
  busy.value = '';
}

async function addSource() {
  if (!newSource.value.name.trim() || !newSource.value.url.trim()) {
    error.value = t('theme.sourceRequired');
    return;
  }
  busy.value = 'source:add';
  try {
    await adminApi.createThemeSource({ name: newSource.value.name.trim(), url: newSource.value.url.trim() });
    newSource.value = { name: '', url: '' };
    await loadSources();
    catalog.value = null;
    reportOk(t('theme.sourceAdded'));
  } catch (e) { reportError(e); }
  busy.value = '';
}

async function toggleSource(src: ThemeSource) {
  busy.value = `source:${src.id}`;
  try {
    await adminApi.updateThemeSource(src.id, { enabled: !src.enabled });
    await loadSources();
    catalog.value = null;
  } catch (e) { reportError(e); }
  busy.value = '';
}

async function removeSource(src: ThemeSource) {
  if (!window.confirm(t('theme.sourceRemoveConfirm', { name: src.name }))) return;
  busy.value = `source:${src.id}`;
  try {
    await adminApi.deleteThemeSource(src.id);
    await loadSources();
    catalog.value = null;
  } catch (e) { reportError(e); }
  busy.value = '';
}

async function installFromMarket(entry: { short: string; source_id: string; name: string }) {
  busy.value = `install:${entry.short}`;
  try {
    await adminApi.installTheme(entry.source_id, entry.short);
    await loadInstalled();
    emit('changed');
    reportOk(t('theme.installedOk', { name: entry.name }));
  } catch (e) { reportError(e); }
  busy.value = '';
}

async function previewImport() {
  if (!importUrl.value.trim()) { error.value = t('theme.urlRequired'); return; }
  busy.value = 'import:preview';
  importPreview.value = null;
  try {
    const res = await adminApi.importTheme(importUrl.value.trim(), true);
    importPreview.value = res.manifest;
    reportOk('');
  } catch (e) { reportError(e); }
  busy.value = '';
}

async function installImport() {
  if (!importUrl.value.trim()) { error.value = t('theme.urlRequired'); return; }
  busy.value = 'import:install';
  try {
    await adminApi.importTheme(importUrl.value.trim(), false);
    importPreview.value = null;
    importUrl.value = '';
    await loadInstalled();
    emit('changed');
    reportOk(t('theme.importedOk'));
  } catch (e) { reportError(e); }
  busy.value = '';
}

function setValue(key: string, value: string | number | boolean) {
  if (configEditor.value) configEditor.value.values[key] = value;
}
function onText(key: string, e: Event) {
  setValue(key, (e.target as HTMLInputElement | HTMLTextAreaElement).value);
}
function onCheck(key: string, e: Event) {
  setValue(key, (e.target as HTMLInputElement).checked);
}
function onSelect(key: string, e: Event) {
  setValue(key, (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="glass p-6 lg:col-span-2">
    <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-lg font-semibold">{{ t('theme.title') }}</h2>
      <div class="flex gap-2 text-sm">
        <button
          v-for="item in TABS"
          :key="item"
          class="rounded-lg border px-3 py-1"
          :class="tab === item
            ? 'border-sky-500 text-sky-300'
            : 'border-slate-700 text-slate-400 hover:border-sky-500'"
          @click="switchTab(item)"
        >{{ tabKey(item) }}</button>
      </div>
    </div>
    <p class="mb-4 text-xs opacity-70">{{ t('theme.hint') }}</p>

    <div v-if="message" class="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-sm text-emerald-200">
      {{ message }}
    </div>
    <div v-if="error" class="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-sm text-rose-200">
      {{ error }}
    </div>

    <!-- 已安装 -->
    <div v-if="tab === 'installed'" class="space-y-2">
      <p v-if="!installed.length" class="text-sm opacity-60">{{ t('theme.empty') }}</p>
      <div
        v-for="item in installed"
        :key="item.short"
        class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700/60 p-3"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ item.name }}</span>
            <span class="text-xs opacity-60">v{{ item.version || '—' }}</span>
            <span v-if="item.bundled" class="rounded bg-slate-700 px-1.5 py-0.5 text-[11px]">{{ t('theme.bundled') }}</span>
            <span v-if="item.enabled" class="rounded bg-emerald-600/30 px-1.5 py-0.5 text-[11px] text-emerald-300">{{ t('theme.enabled') }}</span>
            <span v-if="item.diting.needsRelaxedCsp" class="rounded bg-amber-600/30 px-1.5 py-0.5 text-[11px] text-amber-300">CSP</span>
          </div>
          <p v-if="item.description" class="mt-1 text-xs opacity-60">{{ item.description }}</p>
          <p class="mt-1 text-xs opacity-50">
            <span v-if="item.author">{{ item.author }} · </span>{{ item.short }}
          </p>
        </div>
        <div class="flex flex-wrap gap-2 text-xs">
          <button
            v-if="!item.enabled"
            class="rounded border border-emerald-700 px-2 py-1 text-emerald-300 hover:border-emerald-400 disabled:opacity-40"
            :disabled="!!busy"
            @click="enableTheme(item)"
          >{{ t('theme.enable') }}</button>
          <a
            :href="`/?theme=${encodeURIComponent(item.short)}`"
            target="_blank"
            class="rounded border border-slate-700 px-2 py-1 text-sky-400 hover:border-sky-500"
          >{{ t('theme.preview') }}</a>
          <button
            v-if="item.configurable"
            class="rounded border border-slate-700 px-2 py-1 hover:border-sky-500"
            @click="openConfig(item)"
          >{{ t('theme.config') }}</button>
          <button
            v-if="!item.bundled"
            class="rounded border border-slate-700 px-2 py-1 hover:border-sky-500 disabled:opacity-40"
            :disabled="!!busy"
            @click="updateTheme(item)"
          >{{ t('theme.update') }}</button>
          <button
            v-if="!item.bundled"
            class="rounded border border-slate-700 px-2 py-1 hover:border-amber-500"
            @click="openBackups(item)"
          >{{ t('theme.backups') }}</button>
          <button
            v-if="!item.bundled"
            class="rounded border border-rose-800 px-2 py-1 text-rose-300 hover:border-rose-500 disabled:opacity-40"
            :disabled="!!busy"
            @click="removeTheme(item)"
          >{{ t('theme.delete') }}</button>
        </div>
      </div>
    </div>

    <!-- 市场 -->
    <div v-else-if="tab === 'market'" class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="rounded-lg border border-slate-700 px-3 py-1 text-sm hover:border-sky-500 disabled:opacity-40"
          :disabled="busy === 'catalog'"
          @click="loadCatalog(true)"
        >{{ t('theme.refresh') }}</button>
        <button
          class="rounded-lg border border-slate-700 px-3 py-1 text-sm hover:border-sky-500"
          @click="sourceDialog = true"
        >{{ t('theme.sourceManage') }}</button>
        <span v-if="catalog" class="text-xs opacity-60">
          {{ t('theme.sourceCount', { n: catalog.sources.length }) }}
        </span>
      </div>

      <div v-if="catalog && catalog.sources.length" class="flex flex-wrap gap-2 text-xs">
        <span
          v-for="s in catalog.sources"
          :key="s.id"
          class="rounded border px-2 py-0.5"
          :class="s.error ? 'border-rose-800 text-rose-300' : 'border-slate-700 opacity-70'"
        >{{ s.name }} · {{ s.error ? t('theme.sourceError') + ': ' + themeErrorMessage(s.error) : s.count }}</span>
      </div>

      <p v-if="!catalog" class="text-sm opacity-60">{{ t('theme.loading') }}</p>
      <p v-else-if="!catalog.themes.length" class="text-sm opacity-60">{{ t('theme.noCatalog') }}</p>

      <div
        v-for="entry in (catalog ? catalog.themes : [])"
        :key="`${entry.source_id}:${entry.short}`"
        class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700/60 p-3"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ entry.name }}</span>
            <span class="text-xs opacity-60">v{{ entry.version || '—' }}</span>
            <span class="rounded bg-slate-700 px-1.5 py-0.5 text-[11px]">{{ entry.source_name }}</span>
          </div>
          <p v-if="entry.description" class="mt-1 text-xs opacity-60">{{ entry.description }}</p>
        </div>
        <div class="flex gap-2 text-xs">
          <a
            v-if="entry.url"
            :href="entry.url"
            target="_blank"
            rel="noopener noreferrer"
            class="rounded border border-slate-700 px-2 py-1 text-sky-400 hover:border-sky-500"
          >{{ t('theme.homepage') }}</a>
          <button
            v-if="entry.installable"
            class="rounded border border-emerald-700 px-2 py-1 text-emerald-300 hover:border-emerald-400 disabled:opacity-40"
            :disabled="!!busy"
            @click="installFromMarket(entry)"
          >{{ t('theme.install') }}</button>
          <span v-else class="px-2 py-1 text-xs opacity-50">{{ t('theme.notInstallable') }}</span>
        </div>
      </div>

      <div class="rounded-lg border border-slate-700/60 p-3">
        <h3 class="mb-2 text-sm font-semibold">{{ t('theme.importTitle') }}</h3>
        <div class="flex flex-wrap gap-2">
          <input
            v-model="importUrl"
            placeholder="https://github.com/owner/theme 或 https://.../theme.zip"
            class="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"
          >
          <button
            class="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-sky-500 disabled:opacity-40"
            :disabled="!!busy"
            @click="previewImport"
          >{{ t('theme.importPreview') }}</button>
          <button
            class="rounded-lg border border-emerald-700 px-3 py-2 text-sm text-emerald-300 hover:border-emerald-400 disabled:opacity-40"
            :disabled="!!busy"
            @click="installImport"
          >{{ t('theme.importInstall') }}</button>
        </div>
        <div v-if="importPreview" class="mt-3 text-xs opacity-70">
          <p>{{ importPreview.name }} · v{{ importPreview.version || '—' }} · {{ importPreview.short }}</p>
          <p v-if="importPreview.description">{{ importPreview.description }}</p>
          <p v-if="isInstalled(importPreview.short)" class="text-amber-300">{{ t('theme.importExists') }}</p>
        </div>
      </div>
    </div>


    <!-- 来源管理弹窗 -->
    <div v-if="sourceDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div class="max-h-[80vh] w-full max-w-xl overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-5">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-base font-semibold">{{ t('theme.sourceManage') }}</h3>
          <button class="text-sm opacity-60 hover:opacity-100" @click="sourceDialog = false">{{ t('theme.close') }}</button>
        </div>
        <p class="mb-3 text-xs opacity-60">{{ t('theme.sourceHint') }}</p>
        <div class="space-y-2">
          <div
            v-for="src in sources"
            :key="src.id"
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700/60 p-3"
          >
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ src.name }}</span>
                <span
                  class="rounded px-1.5 py-0.5 text-[11px]"
                  :class="src.enabled ? 'bg-emerald-600/30 text-emerald-300' : 'bg-slate-700'"
                >{{ src.enabled ? t('theme.enabled') : t('theme.disabled') }}</span>
              </div>
              <p class="mt-1 break-all text-xs opacity-50">{{ src.url }}</p>
            </div>
            <div class="flex gap-2 text-xs">
              <button
                class="rounded border border-slate-700 px-2 py-1 hover:border-sky-500 disabled:opacity-40"
                :disabled="!!busy"
                @click="toggleSource(src)"
              >{{ src.enabled ? t('theme.disable') : t('theme.enable') }}</button>
              <button
                class="rounded border border-rose-800 px-2 py-1 text-rose-300 hover:border-rose-500 disabled:opacity-40"
                :disabled="!!busy"
                @click="removeSource(src)"
              >{{ t('theme.delete') }}</button>
            </div>
          </div>
          <p v-if="!sources.length" class="text-sm opacity-60">{{ t('theme.noSources') }}</p>
        </div>
        <div class="mt-3 rounded-lg border border-slate-700/60 p-3">
          <h4 class="mb-2 text-sm font-semibold">{{ t('theme.addSource') }}</h4>
          <div class="flex flex-wrap gap-2">
            <input
              v-model="newSource.name"
              :placeholder="t('theme.sourceName')"
              class="w-40 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"
            >
            <input
              v-model="newSource.url"
              placeholder="https://example.com/v1.json"
              class="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"
            >
            <button
              class="rounded-lg border border-sky-700 px-3 py-2 text-sm text-sky-300 hover:border-sky-400 disabled:opacity-40"
              :disabled="!!busy"
              @click="addSource"
            >{{ t('theme.add') }}</button>
          </div>
        </div>
      </div>
    </div>


    <!-- 备份弹窗 -->
    <div v-if="backups" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div class="max-h-[80vh] w-full max-w-md overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-5">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-base font-semibold">{{ t('theme.backupsTitle', { short: backupsFor }) }}</h3>
          <button class="text-sm opacity-60 hover:opacity-100" @click="backups = null">{{ t('theme.close') }}</button>
        </div>
        <p v-if="!backups.length" class="text-sm opacity-60">{{ t('theme.noBackups') }}</p>
        <div v-else class="space-y-2">
          <div
            v-for="b in backups"
            :key="b.name"
            class="flex items-center justify-between gap-2 rounded border border-slate-700/60 p-2 text-sm"
          >
            <div>
              <p>{{ new Date(b.created_at).toLocaleString() }}</p>
              <p class="text-xs opacity-50">{{ Math.round(b.size / 1024) }} KB</p>
            </div>
            <button
              class="rounded border border-amber-700 px-2 py-1 text-xs text-amber-300 hover:border-amber-400 disabled:opacity-40"
              :disabled="!!busy"
              @click="rollback(b)"
            >{{ t('theme.rollback') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 配置弹窗 -->
    <div v-if="configEditor" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div class="max-h-[80vh] w-full max-w-lg overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-5">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-base font-semibold">{{ t('theme.configTitle', { name: configEditor.name }) }}</h3>
          <button class="text-sm opacity-60 hover:opacity-100" @click="configEditor = null">{{ t('theme.close') }}</button>
        </div>
        <div v-for="f in configEditor.fields" :key="f.key" class="mb-3">
          <label class="mb-1 block text-sm text-slate-400">
            {{ f.name }}<span v-if="f.required" class="text-rose-400"> *</span>
          </label>
          <select
            v-if="f.type === 'select'"
            :value="String(configEditor.values[f.key] ?? '')"
            class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white"
            @change="onSelect(f.key, $event)"
          >
            <option v-for="opt in f.options" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <textarea
            v-else-if="f.type === 'textarea'"
            :value="String(configEditor.values[f.key] ?? '')"
            rows="3"
            class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white"
            @input="onText(f.key, $event)"
          />
          <input
            v-else-if="f.type === 'boolean'"
            type="checkbox"
            :checked="configEditor.values[f.key] === true || configEditor.values[f.key] === 'true'"
            @change="onCheck(f.key, $event)"
          >
          <input
            v-else
            :type="f.type === 'number' ? 'number' : (f.type === 'color' ? 'color' : 'text')"
            :value="String(configEditor.values[f.key] ?? '')"
            class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white"
            @input="onText(f.key, $event)"
          >
          <p v-if="f.help" class="mt-1 text-xs opacity-50">{{ f.help }}</p>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <button class="rounded-lg border border-slate-700 px-3 py-2 text-sm" @click="configEditor = null">{{ t('theme.cancel') }}</button>
          <button
            class="rounded-lg border border-sky-700 px-3 py-2 text-sm text-sky-300 hover:border-sky-400 disabled:opacity-40"
            :disabled="!!busy"
            @click="saveConfig"
          >{{ t('theme.configSave') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
