import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check, object, readJson, text, thinkingLevels } from './config.js';
import type { Candidate, Thinking } from './types.js';

export async function importProfiles(directory: string): Promise<Candidate[]> {
  const catalog = new Map<string, Candidate>();
  const roles = new Set(['advisor', 'builder', 'checker']);
  let preferred = '';
  try { preferred = (await readFile(join(directory, 'ACTIVE'), 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const file of (await readdir(directory)).filter(f => f.endsWith('.json')).sort()) {
    const guide = object(await readJson(join(directory, file)));
    text(guide.name);
    const models = object(guide.models), recommendations = object(guide.recommendations);
    const defaults = Object.entries(models).flatMap(([model, value]) => {
      const metadata = object(value);
      return metadata.defaultThinking === undefined ? [] : [{ model, thinking: metadata.defaultThinking, fit: 'Explicit catalog default; recommendations are preferences, not eligibility constraints.' }];
    });
    const entries: [string | undefined, unknown][] = [[undefined, defaults], ...Object.entries(recommendations)];
    for (const [role, raw] of entries) {
      if (role !== undefined) { text(role); roles.add(role); }
      check(Array.isArray(raw), 'Invalid profile recommendations');
      raw.forEach((entry: unknown, rank: number) => {
        const r = object(entry); text(r.model); text(r.fit);
        check(thinkingLevels.includes(r.thinking), 'Profile reasoning effort missing/invalid');
        const pool = r.model.startsWith('openai-codex/') ? 'codex' : /^(claude-bridge|anthropic)\//.test(r.model) ? 'claude' : r.model.startsWith('cursor/') ? 'cursor' : undefined;
        check(pool, 'Configure quota pool for unrecognized profile provider');
        const id = `${r.model}@${r.thinking}`;
        const order = role === undefined ? 1000 : rank + (guide.name === preferred ? 0 : 100);
        const candidate: Candidate = catalog.get(id) ?? {
          id, model: r.model, thinking: r.thinking as Thinking, roles: [],
          harnesses: pool === 'cursor' || (pool === 'codex' && r.thinking === 'max') ? ['pi'] : ['pi', 'native'],
          pool, fit: '', prior: 0.7, rank: order, enabled: true, profiles: [], benchmarks: [],
        } satisfies Candidate;
        const firstProfile = !candidate.profiles.includes(guide.name);
        if (firstProfile) candidate.profiles.push(guide.name);
        const character = object(models[r.model]).character;
        text(character);
        candidate.fit += `${candidate.fit ? '\n' : ''}[${guide.name}/${role ?? 'catalog'}] ${r.fit}${firstProfile ? `\n${character}` : ''}`;
        candidate.rank = Math.min(candidate.rank, order);
        candidate.roleRanks ??= {};
        if (role !== undefined) candidate.roleRanks[role] = Math.min(candidate.roleRanks[role] ?? Infinity, order);
        catalog.set(id, candidate);
      });
    }
  }
  for (const candidate of catalog.values()) {
    candidate.roles = [...roles];
    candidate.roleRanks = Object.fromEntries(candidate.roles.map(role => [role, candidate.roleRanks?.[role] ?? 1000]));
  }
  return [...catalog.values()];
}
