import { volumeAt } from '../clipLook.mjs';

// One sound plan for export and audible review, including keyframes and ducking.
export function projectSounds(project, sounds, volumes = {}) {
  const roles = new Map(project.tracks.flatMap(track => {
    const role = track.narration ? 'voice' : track.duck ? 'duck' : null;
    return role ? (track.segments ?? []).flatMap(s => [[s.id, role], [`${s.id}-audio`, role]]) : [];
  }));
  return sounds.map(sound => {
    const segment = volumes[sound.clip];
    const count = segment ? Math.max(2, Math.ceil(segment.timeline.duration_us / 10_000) + 1) : 0;
    const gain = segment ? Array.from({ length: count }, (_, i) => Math.round(volumeAt(segment, i / (count - 1) * segment.timeline.duration_us) * 1e4) / 1e4) : null;
    return { ...sound, ...(roles.has(sound.clip) ? { role: roles.get(sound.clip) } : {}), ...(gain ? { gain } : {}) };
  });
}
