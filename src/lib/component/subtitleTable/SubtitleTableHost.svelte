<script lang="ts">
import SubtitleTable from "./SubtitleTable.svelte";
import ReferenceSubtitleTable, { type ReferenceRow } from "./ReferenceSubtitleTable.svelte";
import { Interface } from "../../frontend/Interface";
import { RichText } from "../../core/RichText";
import type { Subtitles } from "../../core/Subtitles.svelte";
import { Basic } from "../../Basic";

import { Trash2Icon } from "@lucide/svelte";
import { _ } from "svelte-i18n";

type ReferenceDoc = {
  id: string;
  name: string;
  path: string;
  showStyle: boolean;
  rows: ReferenceRow[];
};

const MAIN_ID = '__main__';
const ADD_ID = '__add__';

let refs = $state<ReferenceDoc[]>([]);
let activeId = $state<string>(MAIN_ID);
let autoFollow = $state(true);
let selectEl = $state<HTMLSelectElement>();

const activeRef = $derived(refs.find((r) => r.id === activeId) ?? null);

function buildReferenceRows(subs: Subtitles): { rows: ReferenceRow[], showStyle: boolean } {
  const rows: ReferenceRow[] = [];
  const seenStyles = new Set<string>();
  let id = 0;

  for (const entry of subs.entries) {
    for (const [style, richText] of entry.texts) {
      const text = RichText.toString(richText);
      if (text.length === 0) continue;
      seenStyles.add(style.name);
      rows.push({
        id: id++,
        start: entry.start,
        end: entry.end,
        styleName: style.name,
        text,
      });
    }
  }

  rows.sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
  return { rows, showStyle: seenStyles.size > 1 };
}

async function addReferenceSubtitles() {
  const paths = await Interface.askOpenFiles();
  if (paths.length === 0) return;

  let lastLoadedId: string | null = null;
  for (const filePath of paths) {
    const subs = await Interface.parseSubtitleSourceInteractive(filePath, true);
    if (!subs) continue;

    const { rows, showStyle } = buildReferenceRows(subs);
    const name = Basic.getFilename(filePath) ?? filePath;
    const existing = refs.find((r) => r.path === filePath);
    if (existing) {
      existing.rows = rows;
      existing.showStyle = showStyle;
      existing.name = name;
      lastLoadedId = existing.id;
    } else {
      const id = crypto.randomUUID();
      refs.push({ id, name, path: filePath, showStyle, rows });
      lastLoadedId = id;
    }
  }

  if (lastLoadedId) {
    activeId = lastLoadedId;
  }
}

async function onSelectChange(ev: Event) {
  const select = ev.currentTarget as HTMLSelectElement;
  const next = select.value;
  if (next === ADD_ID) {
    // Restore immediately so canceling the dialog doesn't leave "+ Add..." selected
    select.value = activeId;
    await addReferenceSubtitles();
    if (selectEl) selectEl.value = activeId;
    return;
  }
  activeId = next;
}

function removeActiveRef() {
  const idx = refs.findIndex((r) => r.id === activeId);
  if (idx < 0) return;
  refs.splice(idx, 1);
  if (refs.length === 0) {
    activeId = MAIN_ID;
  } else {
    activeId = refs[Math.min(idx, refs.length - 1)].id;
  }
}
</script>

<div class="host vlayout">
  <div class="toolbar hlayout center-items">
    <select
      bind:this={selectEl}
      class="subtitle-select"
      value={activeId}
      onchange={(e) => void onSelectChange(e)}
    >
      <option value={MAIN_ID}>{$_('table.main-subtitle')}</option>
      {#each refs as ref (ref.id)}
        <option value={ref.id}>{ref.name}</option>
      {/each}
      <option value={ADD_ID}>{$_('table.add-reference-subtitle')}</option>
    </select>

    {#if activeRef}
      <label class="follow-toggle">
        <input type="checkbox" bind:checked={autoFollow} />
        {$_('table.follow-playback')}
      </label>
      <span class="ref-count">
        {$_('table.reference-entry-count', { values: { n: activeRef.rows.length } })}
      </span>
      <button
        type="button"
        class="remove-btn"
        aria-label={$_('table.remove-reference-subtitle')}
        title={$_('table.remove-reference-subtitle')}
        onclick={removeActiveRef}
      >
        <Trash2Icon size={14} />
      </button>
    {/if}
  </div>

  <div class="body flexgrow">
    <div class="pane" class:hidden={activeId !== MAIN_ID}>
      <SubtitleTable />
    </div>
    {#if activeRef}
      <div class="pane">
        <ReferenceSubtitleTable
          rows={activeRef.rows}
          showStyle={activeRef.showStyle}
          bind:autoFollow
        />
      </div>
    {/if}
  </div>
</div>

<style lang="scss">
.host {
  width: 100%;
  height: 100%;
  min-height: 0;
}

.toolbar {
  flex: none;
  gap: 8px;
  padding: 2px 2px 4px 2px;
}

.subtitle-select {
  max-width: 260px;
  min-width: 120px;
}

.follow-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
}

.ref-count {
  margin-left: auto;
  font-size: 0.9em;
  opacity: 0.65;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.remove-btn {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
}

.body {
  position: relative;
  min-height: 0;
  width: 100%;
}

.pane {
  width: 100%;
  height: 100%;
}

.hidden {
  display: none;
}
</style>
