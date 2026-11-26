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
  rows: readonly ReferenceRow[];
  showStyle: boolean;
  autoFollow?: boolean;
}

const OVERSCAN = 8;

let { rows, showStyle, autoFollow = $bindable(true) }: Props = $props();

let containerEl = $state<HTMLDivElement>();
let scrollTop = $state(0);
let viewportHeight = $state(400);

// Only mutate reactive active state when the active row set or primary index actually changes,
// so 60/120Hz Playback.onPositionChanged updates do ZERO Svelte reactivity or DOM work during steady playback.
let activeIndices = $state.raw<ReadonlySet<number>>(new Set());
let primaryIndex = $state(-1);
let lastScrolledIndex = -1;

// Precompute estimated vertical offsets for virtual scrolling so only ~25-40 visible rows exist in the DOM.
const layout = $derived.by(() => {
  const n = rows.length;
  const offsets = new Float64Array(n + 1);
  let y = 0;
  for (let i = 0; i < n; i++) {
    offsets[i] = y;
    const text = rows[i].text;
    const explicitLines = text.split('\n').length;
    const wrappedLines = Math.max(explicitLines, Math.ceil(text.length / 36));
    y += Math.max(40, 14 + wrappedLines * 20);
  }
  offsets[n] = y;
  return { offsets, totalHeight: y };
});

function findIndexAtOffset(offsets: Float64Array, targetY: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= targetY) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

const visibleRange = $derived.by(() => {
  const n = rows.length;
  if (n === 0) return { start: 0, end: 0, topOffset: 0 };
  const first = findIndexAtOffset(layout.offsets, scrollTop);
  const last = findIndexAtOffset(layout.offsets, scrollTop + viewportHeight);
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(n, last + OVERSCAN + 1);
  return { start, end, topOffset: layout.offsets[start] };
});

const visibleRows = $derived(rows.slice(visibleRange.start, visibleRange.end));

function computeActiveAt(t: number): { active: Set<number>, primary: number } {
  const active = new Set<number>();
  const n = rows.length;
  if (n === 0) return { active, primary: -1 };

  let lo = 0;
  let hi = n - 1;
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
    primary: firstActive >= 0 ? firstActive : rightMost,
  };
}

function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

function syncPosition(t: number) {
  const { active, primary } = computeActiveAt(t);
  if (primary !== primaryIndex) {
    primaryIndex = primary;
  }
  if (!setsEqual(active, activeIndices)) {
    activeIndices = active;
  }
}

$effect(() => {
  // Re-sync whenever the active reference document changes
  void rows;
  lastScrolledIndex = -1;
  syncPosition(Playback.position);
});

let animRaf = 0;
function cancelScrollAnimation() {
  if (animRaf) {
    cancelAnimationFrame(animRaf);
    animRaf = 0;
  }
}

function animateScrollTo(targetTop: number, durationMs = 240) {
  if (!containerEl) return;
  cancelScrollAnimation();

  const maxScroll = Math.max(0, containerEl.scrollHeight - containerEl.clientHeight);
  const clampedTarget = Math.min(maxScroll, Math.max(0, targetTop));
  const startTop = containerEl.scrollTop;
  const diff = clampedTarget - startTop;
  if (Math.abs(diff) < 2) return;

  // Instant jump for large seeks (e.g. scrubbing across the timeline)
  if (Math.abs(diff) >= viewportHeight * 1.5 || durationMs <= 0) {
    containerEl.scrollTop = clampedTarget;
    scrollTop = containerEl.scrollTop;
    return;
  }

  const startTime = performance.now();
  const step = (now: number) => {
    if (!containerEl) {
      animRaf = 0;
      return;
    }
    const t = Math.min(1, (now - startTime) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    containerEl.scrollTop = startTop + diff * eased;
    scrollTop = containerEl.scrollTop;
    if (t < 1) {
      animRaf = requestAnimationFrame(step);
    } else {
      animRaf = 0;
    }
  };
  animRaf = requestAnimationFrame(step);
}

$effect(() => {
  const idx = primaryIndex;
  if (!autoFollow || idx < 0 || idx === lastScrolledIndex || !containerEl) return;
  lastScrolledIndex = idx;

  // If the target row is already mounted in the virtual window (true for sequential playback),
  // compute its exact position directly and glide smoothly without a two-step jump.
  const mountedRow = containerEl.querySelector<HTMLElement>(`[data-row-index="${idx}"]`);
  if (mountedRow) {
    const containerRect = containerEl.getBoundingClientRect();
    const rowRect = mountedRow.getBoundingClientRect();
    const relTop = rowRect.top - containerRect.top;
    const comfortTop = containerRect.height * 0.22;
    const comfortBottom = containerRect.height * 0.52;
    if (relTop >= comfortTop && relTop <= comfortBottom) return;

    const desiredTop = containerRect.height * 0.36;
    animateScrollTo(containerEl.scrollTop + (relTop - desiredTop), 240);
    return;
  }

  // Row is outside the current virtual window (e.g. after seeking): jump near it, then align once mounted.
  const estimatedTop = Math.max(0, layout.offsets[idx] - viewportHeight * 0.36);
  cancelScrollAnimation();
  containerEl.scrollTop = estimatedTop;
  scrollTop = containerEl.scrollTop;

  void tick().then(() => {
    if (!containerEl) return;
    const rowEl = containerEl.querySelector<HTMLElement>(`[data-row-index="${idx}"]`);
    if (!rowEl) return;
    const containerRect = containerEl.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    const delta = (rowRect.top - containerRect.top) - containerRect.height * 0.36;
    if (Math.abs(delta) > 16) {
      containerEl.scrollTop = Math.max(0, containerEl.scrollTop + delta);
      scrollTop = containerEl.scrollTop;
    }
  });
});

let scrollRaf = 0;
function onScroll() {
  if (!containerEl || scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (containerEl) scrollTop = containerEl.scrollTop;
  });
}

onMount(() => {
  const me = {};
  syncPosition(Playback.position);
  Playback.onPositionChanged.bind(me, (pos) => {
    syncPosition(pos);
  });

  let ro: ResizeObserver | undefined;
  if (containerEl) {
    viewportHeight = containerEl.clientHeight || 400;
    ro = new ResizeObserver(() => {
      if (containerEl) viewportHeight = containerEl.clientHeight || 400;
    });
    ro.observe(containerEl);
  }

  return () => {
    EventHost.unbind(me);
    ro?.disconnect();
    cancelScrollAnimation();
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
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

<div
  bind:this={containerEl}
  class="ref-table-container area"
  role="table"
  onscroll={onScroll}
  onwheel={cancelScrollAnimation}
  onpointerdown={cancelScrollAnimation}
>
  {#if rows.length === 0}
    <div class="empty-hint">{$_('table.reference-empty')}</div>
  {:else}
    <div class="virtual-spacer" style="height: {layout.totalHeight}px;">
      <div class="virtual-window" style="transform: translateY({visibleRange.topOffset}px);">
        {#each visibleRows as row, offset (row.id)}
          {@const idx = visibleRange.start + offset}
          {@const isActive = activeIndices.has(idx)}
          <div
            class="ref-row"
            class:active={isActive}
            role="row"
            tabindex="-1"
            data-row-index={idx}
            title={$_('table.jump-to-line-hint')}
            ondblclick={() => void seekToRow(row.start)}
          >
            <div class="time-col">
              <div class="time-start">{Basic.formatTimestamp(row.start, 2)}</div>
              <div class="time-end">{Basic.formatTimestamp(row.end, 2)}</div>
            </div>
            {#if showStyle}
              <div class="style-col">
                <span class="style-badge" title={row.styleName}>{row.styleName}</span>
              </div>
            {/if}
            <div class="text-col">{row.text}</div>
            <div class="action-col">
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
            </div>
          </div>
        {/each}
      </div>
    </div>
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

.virtual-spacer {
  position: relative;
  width: 100%;
}

.virtual-window {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  will-change: transform;
}

.ref-row {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 6px;
  font-size: var(--fontSize);
  border-bottom: 1px solid var(--uchu-gray-2);
  cursor: default;
  contain: layout style;
  transition: background-color 140ms ease;

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

.time-col {
  flex: 0 0 82px;
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
  flex: 0 0 92px;
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
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
  white-space: pre-wrap;
  font-family: var(--editorFontFamily);
  user-select: text;
  -webkit-user-select: text;
}

.action-col {
  flex: 0 0 24px;
  text-align: right;
}

.copy-btn {
  opacity: 0.35;
  padding: 2px 4px;
  min-width: 0;
  border: none;
  background: transparent;
  box-shadow: none;

  .ref-row:hover &,
  .ref-row.active & {
    opacity: 0.85;
  }

  &:hover {
    opacity: 1 !important;
  }
}
</style>
