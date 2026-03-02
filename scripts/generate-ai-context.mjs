#!/usr/bin/env node
/**
 * scripts/generate-ai-context.mjs
 *
 * Generates AI-readable Markdown documentation for the Slidev theme used
 * in this project. ALL information is derived directly from the installed
 * theme's source files — the README.md is NOT read.
 *
 * Sources:
 *   1. <theme>/layouts/*.vue    → layout names, TypeScript props, slots, root CSS class
 *   2. <theme>/components/*.vue → component names, TypeScript props
 *   3. slides.md (project root) → real usage examples per layout/component
 *
 * Layout groups are inferred from prop signatures and root-element CSS classes
 * found in the Vue files, so the output stays accurate as the theme evolves.
 *
 * Usage:
 *   node scripts/generate-ai-context.mjs [--output <path>]
 *   bun  scripts/generate-ai-context.mjs [--output <path>]
 *
 * Options:
 *   --output <path>   Write to a file instead of stdout
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const outputIdx = args.indexOf('--output')
const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null

// ── File helpers ──────────────────────────────────────────────────────────────

async function tryRead(filePath) {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

async function listVueFiles(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.vue'))
  } catch {
    return []
  }
}

// ── Theme detection ───────────────────────────────────────────────────────────

/**
 * Detect the active theme name from slides.md `theme:` frontmatter.
 * Falls back to the first `slidev-theme-*` entry in package.json.
 */
async function detectTheme() {
  // Priority 1: slides.md frontmatter  (most reliable — it's the active theme)
  const slides = await tryRead(join(ROOT, 'slides.md'))
  const fmMatch = slides.match(/^theme:\s*(.+)$/m)
  if (fmMatch) {
    const short = fmMatch[1].trim()
    const full = short.includes('/') || short.includes('-theme-') ? short : `slidev-theme-${short}`
    return { themeName: full, shortName: short }
  }

  // Priority 2: package.json (custom slidev-theme-* before @slidev/theme-*)
  const pkgText = await tryRead(join(ROOT, 'package.json'))
  if (pkgText) {
    const pkg = JSON.parse(pkgText)
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    const found =
      Object.keys(deps).find((k) => /^slidev-theme-/.test(k) && !k.startsWith('@')) ??
      Object.keys(deps).find((k) => /^@slidev\/theme-/.test(k))
    if (found) {
      return { themeName: found, shortName: found.replace(/^.*theme-/, '') }
    }
  }

  return { themeName: 'slidev-theme', shortName: 'unknown' }
}

// ── Vue component parsers ─────────────────────────────────────────────────────

/**
 * Extract typed props from `defineProps<{...}>()` or `withDefaults(defineProps<{...}>(), {...})`.
 *
 * Uses depth-aware `{}`-tracking so complex types like `Array<{ a: string; b: string }>`
 * are captured in full and the `;` inside nested braces is not mistaken for a separator.
 */
function extractProps(content) {
  const marker = 'defineProps<{'
  const markerIdx = content.indexOf(marker)
  if (markerIdx === -1) return []

  // Walk forward counting brace depth to find the closing `}` of defineProps<{...}>
  let depth = 1
  let i = markerIdx + marker.length
  const blockStart = i
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++
    else if (content[i] === '}') depth--
    i++
  }
  if (depth !== 0) return []
  const propsBlock = content.slice(blockStart, i - 1)

  // Split into prop tokens, treating `\n` and `;` as separators only at depth 0
  const tokens = []
  let current = ''
  let bracketDepth = 0
  for (const ch of propsBlock) {
    if (ch === '{') {
      bracketDepth++
      current += ch
    } else if (ch === '}') {
      bracketDepth--
      current += ch
    } else if ((ch === '\n' || ch === ';') && bracketDepth === 0) {
      const t = current.trim()
      if (t) tokens.push(t)
      current = ''
    } else {
      current += ch
    }
  }
  const last = current.trim()
  if (last) tokens.push(last)

  const props = []
  for (const token of tokens) {
    const m = token.match(/^(\w+)(\?)?:\s*(.+)$/)
    if (m) props.push({ name: m[1], optional: !!m[2], type: m[3].trim() })
  }
  return props
}

/**
 * Extract default values from `withDefaults(defineProps<...>(), { k: v, ... })`.
 * Splits on `,` or `\n` at depth 0 so multiple defaults on one line are handled correctly.
 */
function extractDefaults(content) {
  const match = content.match(/withDefaults\s*\([\s\S]*?,\s*\{([\s\S]*?)\}\s*\)/s)
  if (!match) return {}

  const tokens = []
  let current = ''
  let depth = 0
  for (const ch of match[1]) {
    if ('({['.includes(ch)) {
      depth++
      current += ch
    } else if (')}]'.includes(ch)) {
      depth--
      current += ch
    } else if ((ch === ',' || ch === '\n') && depth === 0) {
      const t = current.trim()
      if (t) tokens.push(t)
      current = ''
    } else {
      current += ch
    }
  }
  const last = current.trim()
  if (last) tokens.push(last)

  const defaults = {}
  for (const token of tokens) {
    const m = token.match(/^(\w+):\s*(.+)$/)
    if (m) defaults[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return defaults
}

/** Extract named slot names from `<slot>` and `<slot name="...">` in the template */
function extractSlots(content) {
  const slots = new Set()
  if (/<slot\s*\/>/.test(content) || /<slot\s*>/.test(content)) slots.add('default')
  for (const [, name] of content.matchAll(/<slot\s+name="([^"]+)"/g)) slots.add(name)
  return [...slots]
}

/**
 * Extract the primary style class from the root element's `class` attribute.
 * e.g. `<div class="slidev-layout frame toc">` → returns `["frame", "toc"]`
 * (the classes after "slidev-layout")
 */
function extractStyleClasses(content) {
  const match = content.match(/class="([^"]+)"/)
  if (!match) return []
  const all = match[1].split(/\s+/)
  const idx = all.indexOf('slidev-layout')
  return idx !== -1 ? all.slice(idx + 1) : []
}

// ── Layout auto-grouping ──────────────────────────────────────────────────────

/**
 * Assign a layout to a group based purely on its prop names and style classes.
 * No layout names are hardcoded here — the logic is driven entirely by
 * what is present in the Vue source.
 */
function resolveGroup(props, styleClasses) {
  const propNames = props.map((p) => p.name)
  const classStr = styleClasses.join(' ')

  if (propNames.includes('image')) return 'Image'
  if (propNames.includes('members')) return 'Team'
  if (propNames.some((n) => ['stats', 'events', 'steps'].includes(n))) return 'Data & Metrics'

  // Layouts whose root class directly says "cover", "section", or contains
  // "title" / "toc" / "section" in the style variant classes
  if (classStr === 'cover') return 'Title & Structure'
  if (classStr === 'section') return 'Title & Structure'
  if (/\b(title|toc|section)\b/.test(classStr)) return 'Title & Structure'

  return 'Content'
}

// ── Theme scanner ─────────────────────────────────────────────────────────────

async function parseTheme(themePath) {
  const layouts = {}
  const components = {}

  for (const file of await listVueFiles(join(themePath, 'layouts'))) {
    const name = file.replace('.vue', '')
    const content = await tryRead(join(themePath, 'layouts', file))
    layouts[name] = {
      props: extractProps(content),
      defaults: extractDefaults(content),
      slots: extractSlots(content),
      styleClasses: extractStyleClasses(content),
    }
  }

  for (const file of await listVueFiles(join(themePath, 'components'))) {
    const name = file.replace('.vue', '')
    const content = await tryRead(join(themePath, 'components', file))
    components[name] = {
      props: extractProps(content),
      defaults: extractDefaults(content),
    }
  }

  return { layouts, components }
}

// ── slides.md extractors ──────────────────────────────────────────────────────

/**
 * Extract the first usage example for each layout.
 * Slides alternate:  [empty, frontmatter₁, content₁, frontmatter₂, content₂, ...]
 * after splitting on `^---$`.
 */
function extractLayoutExamples(slidesContent) {
  const examples = {}
  const parts = slidesContent.split(/^---$/m)
  for (let i = 1; i < parts.length - 1; i += 2) {
    const frontmatter = parts[i].trim()
    const content = (parts[i + 1] ?? '').trim()
    const m = frontmatter.match(/^layout:\s*(.+)$/m)
    if (m) {
      const layout = m[1].trim()
      if (!examples[layout]) examples[layout] = { frontmatter, content }
    }
  }
  return examples
}

/**
 * Extract up to `limit` inline usage lines per component tag from slides.md.
 */
function extractComponentExamples(slidesContent, componentNames, limit = 3) {
  const examples = {}
  for (const name of componentNames) {
    const found = []
    for (const line of slidesContent.split('\n')) {
      const t = line.trim()
      if (t.includes(`<${name}`) && !t.startsWith('//') && !t.startsWith('#')) {
        found.push(t)
        if (found.length >= limit) break
      }
    }
    if (found.length > 0) examples[name] = found
  }
  return examples
}

// ── Render helpers ─────────────────────────────────────────────────────────────

function renderProp(prop, defaults) {
  const req = prop.optional ? 'optional' : 'required'
  const def = defaults[prop.name] !== undefined ? `, default: \`${defaults[prop.name]}\`` : ''
  return `- \`${prop.name}\` (${req}): \`${prop.type}\`${def}`
}

function renderLayoutExample(frontmatter, content) {
  const body = content ? `\n\n${content}` : ''
  return `\`\`\`markdown\n---\n${frontmatter}\n---${body}\n\`\`\``
}

// ── Main generator ─────────────────────────────────────────────────────────────

async function generate() {
  const { themeName, shortName } = await detectTheme()
  const themePath = join(ROOT, 'node_modules', themeName)

  const [{ layouts, components }, slidesContent] = await Promise.all([
    parseTheme(themePath),
    tryRead(join(ROOT, 'slides.md')),
  ])

  const layoutExamples = extractLayoutExamples(slidesContent)
  const componentExamples = extractComponentExamples(slidesContent, Object.keys(components))

  // Group layouts — order is fixed but membership is inferred from Vue source
  const GROUP_ORDER = ['Title & Structure', 'Content', 'Data & Metrics', 'Team', 'Image']
  const groups = Object.fromEntries(GROUP_ORDER.map((g) => [g, []]))

  for (const [name, layout] of Object.entries(layouts)) {
    const group = resolveGroup(layout.props, layout.styleClasses)
    ;(groups[group] ?? (groups['Other'] = [])).push(name)
  }

  const out = []

  // ── Header ────────────────────────────────────────────────────────────────────
  out.push(`# ${themeName}: AI Context Reference`)
  out.push('')
  out.push(
    `This document describes every layout and component in **${themeName}**.` +
      " It is generated automatically from the theme's Vue source files."
  )
  out.push('')
  out.push(
    '> **How to use**: Give this document as context to an AI, then describe the' +
      ' slides you want. The AI will produce a complete `slides.md` runnable with `bun dev`.'
  )
  out.push('')

  // ── Global frontmatter ────────────────────────────────────────────────────────
  out.push('## Global Frontmatter')
  out.push('')
  out.push('The **first** block of every `slides.md` declares the theme:')
  out.push('')
  out.push('```yaml')
  out.push('---')
  out.push(`theme: ${shortName}`)
  out.push('title: Your Presentation Title')
  out.push('transition: slide-left')
  out.push('mdc: true')
  out.push('layout: cover')
  out.push('---')
  out.push('')
  out.push('# Slide Title')
  out.push('## Subtitle or date')
  out.push('```')
  out.push('')

  // ── Slide format (with blank-page warning) ────────────────────────────────────
  out.push('## Slide Format')
  out.push('')
  out.push(
    'Slides are separated by `---`. For a slide **with frontmatter**, the `---` serves as' +
      ' both the separator (ending the previous slide) and the frontmatter opener for the new slide.' +
      ' Write frontmatter content directly after the `---`, then close it with another `---`.'
  )
  out.push('')
  out.push('```markdown')
  out.push('---')
  out.push('layout: <layout-name>')
  out.push('[propName: value]')
  out.push('---')
  out.push('')
  out.push('Default slot content (Markdown)')
  out.push('')
  out.push('::slotname::')
  out.push('')
  out.push('Named slot content')
  out.push('```')
  out.push('')
  out.push('**Connecting two slides correctly:**')
  out.push('')
  out.push('```markdown')
  out.push('---')
  out.push('layout: section')
  out.push('---')
  out.push('')
  out.push('# Chapter 1')
  out.push('')
  out.push('---')
  out.push('layout: panel')
  out.push('color: black')
  out.push('align: left')
  out.push('---')
  out.push('')
  out.push('Panel content here.')
  out.push('```')
  out.push('')
  out.push(
    '> **BLANK-PAGE WARNING**: Never place an extra `---` between the closing `---` of' +
      ' one slide and the opening `---` of the next. Each `---` transition is a single line,' +
      ' not two.'
  )
  out.push('')
  out.push('```markdown')
  out.push('# ✗ Wrong — creates a blank slide between section and panel:')
  out.push('---')
  out.push('layout: section')
  out.push('---')
  out.push('')
  out.push('# Chapter 1')
  out.push('')
  out.push('---')
  out.push('')
  out.push('---')
  out.push('layout: panel')
  out.push('---')
  out.push('```')
  out.push('')
  out.push(
    '**Named slot syntax**: `::slotname::` on its own line switches to a named slot region.' +
      ' Content before the first `::slotname::` goes into the `default` slot.'
  )
  out.push('')

  // ── Layouts ───────────────────────────────────────────────────────────────────
  out.push('## Layouts')
  out.push('')
  out.push(`The theme ships **${Object.keys(layouts).length} layouts**, grouped below.`)
  out.push('')

  for (const groupName of [...GROUP_ORDER, 'Other']) {
    const names = groups[groupName]
    if (!names || names.length === 0) continue

    out.push(`### ${groupName}`)
    out.push('')

    for (const name of names) {
      const layout = layouts[name]
      if (!layout) continue

      out.push(`#### \`${name}\``)
      out.push('')

      // Factual style info derived from the root element's CSS class
      if (layout.styleClasses.length > 0) {
        out.push(`Style classes: \`${layout.styleClasses.join(' ')}\``)
        out.push('')
      }

      if (layout.props.length > 0) {
        out.push('**Props:**')
        out.push('')
        for (const prop of layout.props) out.push(renderProp(prop, layout.defaults))
        out.push('')
      }

      if (layout.slots.length > 0) {
        out.push('**Slots:**')
        out.push('')
        for (const slot of layout.slots) {
          const syntax =
            slot === 'default'
              ? 'write content directly after `---`'
              : `use \`::${slot}::\` on its own line`
          out.push(`- \`${slot}\`: ${syntax}`)
        }
        out.push('')
      }

      const ex = layoutExamples[name]
      if (ex) {
        out.push('**Example:**')
        out.push('')
        out.push(renderLayoutExample(ex.frontmatter, ex.content))
        out.push('')
      }
    }
  }

  // ── Components ────────────────────────────────────────────────────────────────
  out.push('## Components')
  out.push('')
  out.push('Components are placed **inline** inside the Markdown content of any layout.')
  out.push('')

  for (const [name, comp] of Object.entries(components)) {
    out.push(`### \`<${name}>\``)
    out.push('')

    if (comp.props.length > 0) {
      out.push('**Props:**')
      out.push('')
      for (const prop of comp.props) out.push(renderProp(prop, comp.defaults))
      out.push('')
    }

    const usages = componentExamples[name]
    if (usages && usages.length > 0) {
      out.push('**Usage examples (from slides.md):**')
      out.push('')
      out.push('```markdown')
      for (const line of usages) out.push(line)
      out.push('```')
      out.push('')
    }
  }

  // ── Quick layout reference ─────────────────────────────────────────────────────
  out.push('## Quick Layout Reference')
  out.push('')
  out.push('| Layout | Style classes | Required props | Named slots |')
  out.push('|---|---|---|---|')
  for (const groupName of [...GROUP_ORDER, 'Other']) {
    const names = groups[groupName]
    if (!names || names.length === 0) continue
    for (const name of names) {
      const layout = layouts[name]
      if (!layout) continue
      const style = layout.styleClasses.join(' ') || '—'
      const required =
        layout.props
          .filter((p) => !p.optional)
          .map((p) => p.name)
          .join(', ') || '—'
      const namedSlots = layout.slots.filter((s) => s !== 'default').join(', ') || '—'
      out.push(`| \`${name}\` | \`${style}\` | ${required} | ${namedSlots} |`)
    }
  }
  out.push('')

  // ── Rules ─────────────────────────────────────────────────────────────────────
  out.push('## Rules for Generating Slides')
  out.push('')
  out.push('Follow these rules precisely when producing `slides.md`:')
  out.push('')
  out.push(
    `1. **Start with global frontmatter** — include \`theme: ${shortName}\`, \`mdc: true\`, and \`layout: cover\`.`
  )
  out.push(
    '2. **Each `---` line is ONE transition** — when a slide has frontmatter, write `---` then' +
      ' frontmatter then `---`. Never insert a bare `---` before the frontmatter block.'
  )
  out.push('3. **Write valid YAML** in each frontmatter block.')
  out.push('4. **Array props** must be YAML arrays with correct indentation.')
  out.push('5. **Named slots** use `::slotname::` on its own line to start a new slot region.')
  out.push('6. **Only use props listed** for each layout — omit unknown props.')
  out.push('7. **Components** go inline inside content blocks, not in frontmatter.')
  out.push('8. **Image URLs** must be valid HTTP(S) URLs.')
  out.push(
    '9. **Do not place `---`** inside fenced code blocks (it is misread as a slide separator).'
  )
  out.push('')

  return out.join('\n')
}

// ── Entry point ───────────────────────────────────────────────────────────────

const markdown = await generate()

if (outputPath) {
  await writeFile(outputPath, markdown, 'utf-8')
  console.error(`✓ Written to ${outputPath}`)
} else {
  process.stdout.write(markdown + '\n')
}
