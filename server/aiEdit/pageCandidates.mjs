import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AiEditError } from './library.mjs';
import { renameRetrying } from './rename.mjs';

// 会话内的候选跨轮/重启保留；正式页仍是唯一被时间线使用的版本。
export function pageCandidates(root, sessionId) {
  const folder = path.join(root, 'candidates', sessionId);
  const file = id => {
    if (!/^[a-f0-9]{32}$/u.test(id ?? '')) throw new AiEditError('preview_not_found', '没有这份候选。', 404);
    return path.join(folder, `${id}.json`);
  };
  const get = async id => {
    try { return JSON.parse(await readFile(file(id), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; throw new AiEditError('preview_not_found', '这份候选已移除，请重新预览。', 404); }
  };
  const list = async () => {
    const names = await readdir(folder).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    return (await Promise.all(names.filter(n => /^[a-f0-9]{32}\.json$/u.test(n)).map(n => get(n.slice(0, -5)))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const put = async candidate => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const target = file(candidate.id);
    await writeFile(`${target}.tmp`, JSON.stringify(candidate), { mode: 0o600 });
    await renameRetrying(`${target}.tmp`, target);
    return candidate;
  };
  return { get, list, put, async review(key, value) {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('Invalid review key');
    const target = path.join(folder, `review-${key}.json`);
    if (value === undefined) { try { return JSON.parse(await readFile(target, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await renameRetrying(`${target}.tmp`, target);
    return value;
  }, async add(value) {
    const candidate = await put({ ...value, id: randomBytes(16).toString('hex'), createdAt: new Date().toISOString(), reviews: [] });
    for (const old of (await list()).slice(6)) await rm(file(old.id), { force: true });
    return candidate;
  } };
}
