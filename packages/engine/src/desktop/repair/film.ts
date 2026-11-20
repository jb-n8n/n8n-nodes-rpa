// The film of what the desktop repair's model saw: each masked, labelled screenshot sent to the model, and each move it
// made, written to a local folder. ONLY for an engine script that sets DesktopRepairInput.debugFilmDir to record a demo
// (the node has no such option): the pictures are the same masked ones the model got, but they then sit on the disk.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatImage } from '../../agent/model.js';

export interface FilmWriter {
  /** One move of the model and the picture it saw last (written once, as picture-NN.png). */
  move(move: string, picture: ChatImage | undefined): void;
}

export function filmWriter(dir: string): FilmWriter {
  mkdirSync(dir, { recursive: true });
  const written = new Map<ChatImage, string>();
  let turn = 0;
  return {
    move(move, picture) {
      turn++;
      let file: string | null = null;
      if (picture) {
        file = written.get(picture) ?? `picture-${String(written.size + 1).padStart(2, '0')}.png`;
        if (!written.has(picture)) {
          writeFileSync(join(dir, file), Buffer.from(picture.base64, 'base64'));
          written.set(picture, file);
        }
      }
      appendFileSync(join(dir, 'moves.jsonl'), `${JSON.stringify({ turn, at: new Date().toISOString(), picture: file, move })}\n`);
    },
  };
}
