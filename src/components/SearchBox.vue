<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import GameArt from './GameArt.vue'
import Icon from './Icon.vue'
import {
  SEARCH_RESULT_LIMIT,
  addToLibrary,
  closeSearch,
  flushSearch,
  openSearch,
  setQuery,
  state,
} from '@/store'
import { classNames, formatNumber, normalizePlatform, preferredExecutable } from '@/utils'

const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const activeIndex = ref(0)

const query = computed({
  get: () => state.query,
  set: (value: string) => {
    activeIndex.value = 0
    setQuery(value)
  },
})

const isOpen = computed(() => state.searchOpen)
const results = computed(() => state.results)
const librarySet = computed(() => new Set(state.library))
const resultLabel = computed(() => {
  if (!state.query.trim()) return ''
  if (state.searchBusy) return 'Searching...'
  if (!results.value.length) return 'No matches'
  return `${results.value.length}${results.value.length === SEARCH_RESULT_LIMIT ? '+' : ''} matches`
})

function handleFocus() {
  openSearch()
}

function handleDocumentPointer(event: PointerEvent) {
  if (!root.value) return
  if (!root.value.contains(event.target as Node)) closeSearch()
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeSearch()
    input.value?.blur()
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    const wasPending = flushSearch()
    if (!results.value.length) return
    if (wasPending) activeIndex.value = 0
    activeIndex.value = Math.min(activeIndex.value, results.value.length - 1)
    choose(results.value[activeIndex.value])
    return
  }

  if (!results.value.length) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % results.value.length
    scrollActiveIntoView()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + results.value.length) % results.value.length
    scrollActiveIntoView()
  }
}

function scrollActiveIntoView() {
  nextTick(() => {
    const node = root.value?.querySelector<HTMLElement>(`[data-result-index="${activeIndex.value}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  })
}

function choose(game: (typeof results.value)[number] | undefined) {
  if (!game) return
  addToLibrary(game)
  input.value?.blur()
}

function focus() {
  input.value?.focus()
  input.value?.select()
}

defineExpose({ focus })

watch(results, () => {
  activeIndex.value = 0
})

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointer)
  window.addEventListener('questline:focus-search', focus)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointer)
  window.removeEventListener('questline:focus-search', focus)
})
</script>

<template>
  <div ref="root" class="search-wrap">
    <div :class="classNames('search-box', isOpen && 'focused')">
      <span class="search-icon"><Icon name="search" :size="19" /></span>
      <input
        ref="input"
        v-model="query"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="Search Discord games by name or alias..."
        aria-label="Search Discord games"
        @focus="handleFocus"
        @keydown="handleKeydown"
      />
      <span v-if="state.searchBusy" class="search-spinner"><Icon name="refresh" :size="16" class="spin" /></span>
      <button
        v-else-if="state.query"
        class="search-clear"
        type="button"
        aria-label="Clear search"
        @click="query = ''; input?.focus()"
      >
        <Icon name="x" :size="15" />
      </button>
      <span v-else class="search-hint"><kbd>/</kbd> to search</span>
    </div>

    <Transition name="search-panel">
      <div v-if="isOpen" class="search-panel">
        <div class="search-panel-head">
          <span>{{ resultLabel || 'Find a game' }}</span>
          <span class="search-source">Discord detectable catalog</span>
        </div>

        <div v-if="results.length" class="search-results">
          <button
            v-for="(game, index) in results"
            :key="game.id"
            type="button"
            :data-result-index="index"
            :class="classNames('search-result', index === activeIndex && 'active')"
            @mouseenter="activeIndex = index"
            @click="choose(game)"
          >
            <GameArt :game="game" :size="40" :radius="11" />
            <span class="result-copy">
              <span class="result-title">
                <span class="truncate">{{ game.name }}</span>
                <span class="verified"><Icon name="verified" :size="13" /></span>
              </span>
              <span class="result-meta">
                <span class="mono">{{ game.id }}</span>
                <span class="meta-dot"></span>
                <span>{{ normalizePlatform(preferredExecutable(game)?.os || 'win32') }}</span>
                <span class="meta-dot"></span>
                <span>{{ game.executables.length }} executable{{ game.executables.length === 1 ? '' : 's' }}</span>
              </span>
            </span>
            <span :class="classNames('result-add', librarySet.has(game.id) && 'in-library')">
              <Icon :name="librarySet.has(game.id) ? 'check' : 'plus'" :size="13" />
              {{ librarySet.has(game.id) ? 'In library' : 'Add' }}
            </span>
          </button>
        </div>

        <div v-else-if="!state.query.trim()" class="search-empty">
          <span class="empty-glyph"><Icon name="gamepad" :size="22" /></span>
          <div>
            <strong>Search {{ formatNumber(state.games.length) }} detectable games</strong>
            <p>Try a title, a short alias, or part of an executable name. Press <kbd>Esc</kbd> to close.</p>
          </div>
        </div>

        <div v-else class="search-empty">
          <span class="empty-glyph"><Icon name="search" :size="21" /></span>
          <div>
            <strong>No games matched “{{ state.query }}”</strong>
            <p>Check the spelling or try a shorter name. The catalog updates from Discord’s detectable games list.</p>
          </div>
        </div>

        <div class="search-panel-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> add to library</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.search-wrap {
  position: relative;
  z-index: 30;
  margin-bottom: 22px;
}

.search-box {
  display: flex;
  height: 56px;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background:
    linear-gradient(120deg, rgba(255, 255, 255, 0.035), transparent 45%),
    var(--panel);
  box-shadow: var(--shadow-soft);
  transition: 0.2s var(--ease);
  backdrop-filter: blur(22px);
}

.search-box.focused,
.search-box:focus-within {
  border-color: rgba(124, 108, 255, 0.5);
  box-shadow:
    0 0 0 4px var(--accent-soft),
    var(--shadow-soft);
}

.search-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  place-items: center;
  border-radius: 9px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.search-box input {
  min-width: 0;
  flex: 1;
  height: 100%;
  border: 0;
  color: var(--text);
  background: transparent;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: -0.01em;
}

.search-box input::placeholder {
  color: var(--text-faint);
}

.search-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 11.5px;
  white-space: nowrap;
}

kbd {
  display: inline-grid;
  min-width: 21px;
  height: 21px;
  place-items: center;
  padding: 0 5px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  color: var(--text-muted);
  background: var(--panel-raised);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
}

.search-clear,
.search-spinner {
  display: grid;
  width: 27px;
  height: 27px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  color: var(--text-muted);
}

.search-clear:hover {
  color: var(--text);
  background: var(--panel-raised);
}

.search-panel {
  position: absolute;
  top: calc(100% + 9px);
  right: 0;
  left: 0;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 17px;
  background: var(--panel-solid);
  box-shadow: var(--shadow);
  animation: search-in 0.18s var(--ease) both;
}

@keyframes search-in {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.995);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.search-panel-head,
.search-panel-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 16px;
  color: var(--text-faint);
  font-size: 11.5px;
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.search-panel-head {
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
}

.search-source {
  color: var(--text-faint);
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: none;
}

.search-results {
  max-height: 388px;
  overflow-y: auto;
  padding: 6px;
}

.search-result {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 11px;
  text-align: left;
  transition: 0.12s ease;
}

.search-result.active {
  border-color: var(--line);
  background: var(--panel-raised);
}

.result-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.result-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 13.5px;
  font-weight: 650;
}

.verified {
  color: var(--accent-blue);
  display: inline-flex;
}

.result-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.meta-dot {
  width: 2px;
  height: 2px;
  flex: none;
  border-radius: 99px;
  background: var(--text-faint);
}

.result-add {
  display: inline-flex;
  height: 30px;
  flex: none;
  align-items: center;
  gap: 5px;
  padding: 0 11px;
  border: 1px solid rgba(124, 108, 255, 0.25);
  border-radius: 8px;
  color: var(--accent-strong);
  background: var(--accent-soft);
  font-size: 12px;
  font-weight: 700;
}

.result-add.in-library {
  color: var(--text-muted);
  border-color: var(--line);
  background: var(--panel-raised);
}

.search-result:hover .result-add:not(.in-library) {
  color: #fff;
  background: var(--accent);
}

.search-empty {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 24px 20px;
}

.empty-glyph {
  display: grid;
  width: 42px;
  height: 42px;
  flex: none;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 12px;
  color: var(--text-muted);
  background: var(--panel-raised);
}

.search-empty strong {
  display: block;
  margin-bottom: 4px;
  color: var(--text-soft);
  font-size: 13.5px;
  font-weight: 650;
}

.search-empty p {
  max-width: 520px;
  color: var(--text-faint);
  font-size: 12.5px;
  line-height: 1.55;
}

.search-empty p kbd {
  min-width: 24px;
  height: 19px;
  font-size: 11px;
}

.search-panel-foot {
  justify-content: flex-end;
  gap: 16px;
  border-top: 1px solid var(--line);
  letter-spacing: 0.01em;
  text-transform: none;
}

.search-panel-foot span {
  display: flex;
  align-items: center;
  gap: 4px;
}

.search-panel-foot kbd {
  min-width: 19px;
  height: 19px;
  font-size: 11px;
}

.search-panel-enter-active,
.search-panel-leave-active {
  transition: opacity 0.17s ease, transform 0.17s var(--ease);
}

.search-panel-enter-from,
.search-panel-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
