#!/usr/bin/env node
/**
 * Install the shipped `readonly-audit` agent preset into the writable user
 * preset root (`$DSH_HOME/.agent-presets` by default). This is the migration
 * path for a harness build that predates the shipped preset directory; new
 * harness builds already carry it under `apps/cli/config/agent-presets/`.
 */

import { cp, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const presetSource = fileURLToPath(new URL('../presets/readonly-audit/', import.meta.url))
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const presetDestination = resolve(process.argv[2] ?? join(dshHome, '.agent-presets', 'readonly-audit'))

if (presetDestination === presetSource) {
  console.error(`refusing to copy the preset onto itself: ${presetDestination}`)
  process.exit(1)
}

await rm(presetDestination, { recursive: true, force: true })
await mkdir(presetDestination, { recursive: true })
await cp(presetSource, presetDestination, { recursive: true })
console.log(`readonly-audit agent preset installed at ${presetDestination}`)
console.log('Restart the harness; the mode appears beside Standard, PTC, Minimal, and Creator.')
