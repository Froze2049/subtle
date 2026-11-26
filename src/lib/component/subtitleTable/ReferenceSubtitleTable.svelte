<script lang="ts">
import { Basic } from "../../Basic";
import { Playback } from "../../frontend/Playback";
import { Frontend } from "../../frontend/Frontend";

import { EventHost } from "@the_dissidents/svelte-ui";
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
import { CopyIcon } from "@lucide/svelte";
import { onMount, tick } from "svelte";
import { _ } from "svelte-i18n";

export type ReferenceRow = {
  id: number;
  start: number;
  end: number;
  styleName: string;
  text: string;
};

interface Props {
  rows: ReferenceRow[];
  showStyle: boolean;
  autoFollow?: boolean;
}

let { rows, showStyle, autoFollow = $bindable(true) }: Props = $props();

let currentTime = $state(Playback.position);
let rowElements: (HTMLTableRowElement | undefined)[] = [];
let lastScrolledIndex = -1;

// Binary search for the first row with start <= t, then scan nearby active rows.
// Also tracks the latest row that has started if playback is in a gap between rows.
const activeState = $derived.by(() => {
  const active = new Set<number>();
  if (rows.length === 0) return { active, primaryIndex: -1 };

  const t = currentTime;
  // Find rightmost index with rows[i].start <= t
  let lo = 0;
  let hi = rows.length - 1;
  let rightMost = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].start <= t) {
      rightMost = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let firstActive = -1;
  // Scan backwards from rightMost to catch overlapping entries (e.g. bilingual tracks)
  for (let i = rightMost; i >= 0; i--) {
    const r = rows[i];
    if (r.end > t) {
      active.add(i);
      firstActive = i;
    } else if (t - r.end > 30) {
      break;
    }
  }

  return {
    active,
    primaryIndex: firstActive >= 0 ? firstActive : rightMost,
  };
});

$effect(() => {
  // Reset scroll tracker whenever the reference subtitle list changes
  void rows;
  lastScrolledIndex = -1;
});

$effect(() => {
  const idx = activeState.primaryIndex;
  if (!autoFollow || idx < 0 || idx === lastScrolledIndex) return;
  lastScrolledIndex = idx;
  void tick().then(() => {
    const el = rowElements[idx];
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
});

onMount(() => {
  const me = {};
  currentTime = Playback.position;
  Playback.onPositionChanged.bind(me, (pos) => {
    currentTime = pos;
  });
  return () => {
    EventHost.unbind(me);
  };
});

async function copyRowText(text: string) {
  await clipboard.writeText(text);
  Frontend.setStatus($_('msg.copied'));
}

async function seekToRow(start: number) {
  if (!Playback.loaded) return;
  await Playback.setPosition(start);
}
</script>

<div class="ref-table-container area">
  {#if rows.length === 0}
    <div class="empty-hint">{$_('table.reference-empty')}</div>
  {:else}
    <table class="ref-table">
      <tbody>
        {#each rows as row, i (row.id)}
          {@const isActive = activeState.active.has(i)}
          <tr
            bind:this={rowElements[i]}
            class:active={isActive}
            title={$_('table.jump-to-line-hint')}
            ondblclick={() => void seekToRow(row.start)}
          >
            <td class="time-col">
              <div class="time-start">{Basic.formatTimestamp(row.start, 2)}</div>
              <div class="time-end">{Basic.formatTimestamp(row.end, 2)}</div>
            </td>
            {#if showStyle}
              <td class="style-col">
                <span class="style-badge" title={row.styleName}>{row.styleName}</span>
              </td>
            {/if}
            <td class="text-col">{row.text}</td>
            <td class="action-col">
              <button
                type="button"
                class="copy-btn"
                aria-label={$_('table.copy-line')}
                title={$_('table.copy-line')}
                onclick={(e) => {
                  e.stopPropagation();
                  void copyRowText(row.text);
                }}
              >
                <CopyIcon size={13} />
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style lang="scss">
.ref-table-container {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  box-sizing: border-box;
  border: 1px solid var(--uchu-gray-3);
  border-radius: 3px;
  background-color: var(--uchu-yin-1);

  @media (prefers-color-scheme: dark) {
    border-color: var(--uchu-yin-7);
    background-color: var(--uchu-yin-9);
  }
}

.empty-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  opacity: 0.6;
  font-style: italic;
}

.ref-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: var(--fontSize);

  tr {
    border-bottom: 1px solid var(--uchu-gray-2);
    cursor: default;

    @media (prefers-color-scheme: dark) {
      border-bottom-color: var(--uchu-yin-8);
    }

    &:hover {
      background-color: rgba(128, 128, 128, 0.08);
    }

    &.active {
      background-color: rgba(59, 130, 246, 0.16);

      @media (prefers-color-scheme: dark) {
        background-color: rgba(96, 165, 250, 0.24);
      }
    }
  }

  td {
    padding: 4px 6px;
    vertical-align: top;
  }
}

.time-col {
  width: 82px;
  font-family: var(--monospaceFontFamily);
  font-variant-numeric: tabular-nums;
  font-size: 0.85em;
  line-height: 1.25;
  white-space: nowrap;
  opacity: 0.78;
}

.time-end {
  opacity: 0.7;
}

.style-col {
  width: 96px;
  overflow: hidden;
}

.style-badge {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.8em;
  background-color: rgba(128, 128, 128, 0.16);
}

.text-col {
  word-break: break-word;
  white-space: pre-wrap;
  font-family: var(--editorFontFamily);
  user-select: text;
  -webkit-user-select: text;
}

.action-col {
  width: 28px;
  text-align: right;
  padding-right: 4px !important;
}

.copy-btn {
  opacity: 0.35;
  padding: 2px 4px;
  min-width: 0;
  border: none;
  background: transparent;
  box-shadow: none;

  tr:hover &,
  tr.active & {
    opacity: 0.85;
  }

  &:hover {
    opacity: 1 !important;
  }
}
</style>
