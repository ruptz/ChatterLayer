'use strict';
// @ts-check
/**
 * Detokenisers for the three ONNX engines.
 *
 * Only decoding is needed — nothing here ever encodes text, because the models
 * are only ever asked to transcribe. That keeps this to a fraction of a real
 * tokenizer: an id -> piece table plus whatever the `decoder` section of
 * tokenizer.json says to do with the pieces.
 *
 * Both formats in use are handled:
 *   tokenizer.json  HuggingFace tokenizers (Whisper: ByteLevel BPE,
 *                   Moonshine: SentencePiece-style BPE with byte fallback)
 *   vocab.txt       "piece id" per line (Parakeet, from NeMo's SentencePiece)
 */

const fs = require('fs');
const path = require('path');

/**
 * GPT-2's byte <-> printable-character mapping. ByteLevel BPE stores raw bytes
 * as printable code points so the vocabulary is text; decoding has to undo it.
 */
function byteDecoder() {
  const map = new Map();
  const direct = [];
  for (let i = 0x21; i <= 0x7e; i++) direct.push(i);
  for (let i = 0xa1; i <= 0xac; i++) direct.push(i);
  for (let i = 0xae; i <= 0xff; i++) direct.push(i);

  for (const b of direct) map.set(String.fromCharCode(b), b);
  let next = 0;
  for (let b = 0; b < 256; b++) {
    if (direct.includes(b)) continue;
    map.set(String.fromCharCode(256 + next), b);
    next++;
  }
  return map;
}

const BYTE_DECODER = byteDecoder();

/** A `<0x41>` style byte-fallback piece, or null. */
function byteFallbackValue(piece) {
  const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(piece);
  return m ? parseInt(m[1], 16) : null;
}

/**
 * Turn a decoder spec from tokenizer.json into a list of steps we can apply.
 * Unknown step types are ignored rather than fatal — a new normaliser appearing
 * upstream should degrade the spacing, not break transcription outright.
 */
function flattenDecoder(spec, into = []) {
  if (!spec) return into;
  if (spec.type === 'Sequence' && Array.isArray(spec.decoders)) {
    for (const d of spec.decoders) flattenDecoder(d, into);
    return into;
  }
  into.push(spec);
  return into;
}

class Detokenizer {
  /**
   * @param {string[]} pieces id -> piece
   * @param {Set<number>} special ids to drop when skipSpecial is set
   * @param {object[]} steps flattened decoder spec
   */
  constructor(pieces, special, steps) {
    this.pieces = pieces;
    this.special = special;
    this.steps = steps;
    this.byteLevel = steps.some((s) => s.type === 'ByteLevel');
    this.replacements = steps.filter((s) => s.type === 'Replace');
    this.strip = steps.find((s) => s.type === 'Strip') || null;
    // Metaspace is the older spelling of the same idea as Replace("_", " ").
    this.metaspace = steps.find((s) => s.type === 'Metaspace') || null;
  }

  /** @param {number[]|Iterable<number>} ids @returns {string} */
  decode(ids, { skipSpecial = true } = {}) {
    /** Assembled as bytes, because byte-fallback pieces are fragments of one
     *  UTF-8 sequence and cannot be decoded on their own. */
    const bytes = [];

    for (const id of ids) {
      if (skipSpecial && this.special.has(id)) continue;
      const piece = this.pieces[id];
      if (piece === undefined) continue;

      const raw = byteFallbackValue(piece);
      if (raw !== null) {
        bytes.push(raw);
        continue;
      }

      if (this.byteLevel) {
        for (const ch of piece) {
          const b = BYTE_DECODER.get(ch);
          // A piece that isn't in the byte table is an added token that was
          // never byte-encoded (e.g. "<|endoftext|>" when specials are kept).
          if (b === undefined) for (const u of Buffer.from(ch, 'utf8')) bytes.push(u);
          else bytes.push(b);
        }
        continue;
      }

      let text = piece;
      for (const r of this.replacements) {
        const pattern = r.pattern && (r.pattern.String ?? r.pattern.Regex);
        if (pattern) text = text.split(pattern).join(r.content ?? '');
      }
      if (this.metaspace) {
        text = text.split(this.metaspace.replacement || '▁').join(' ');
      }
      for (const b of Buffer.from(text, 'utf8')) bytes.push(b);
    }

    let text = Buffer.from(bytes).toString('utf8');

    if (this.strip) {
      const ch = this.strip.content || ' ';
      for (let i = 0; i < (this.strip.start || 0) && text.startsWith(ch); i++) {
        text = text.slice(ch.length);
      }
      for (let i = 0; i < (this.strip.stop || 0) && text.endsWith(ch); i++) {
        text = text.slice(0, -ch.length);
      }
    }
    return text;
  }
}

/** HuggingFace tokenizer.json. */
function fromTokenizerJson(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pieces = [];
  const special = new Set();

  const vocab = (json.model && json.model.vocab) || {};
  // Moonshine's vocab is a plain object; some exports use an array of pairs.
  if (Array.isArray(vocab)) {
    for (const [piece, id] of vocab) pieces[id] = piece;
  } else {
    for (const piece of Object.keys(vocab)) pieces[vocab[piece]] = piece;
  }

  for (const t of json.added_tokens || []) {
    pieces[t.id] = t.content;
    if (t.special) special.add(t.id);
  }

  return new Detokenizer(pieces, special, flattenDecoder(json.decoder));
}

/**
 * NeMo's SentencePiece vocabulary as exported alongside the Parakeet ONNX
 * graphs: one "piece id" per line, `<blk>` last.
 */
function fromVocabTxt(file) {
  const pieces = [];
  const special = new Set();

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const cut = line.lastIndexOf(' ');
    if (cut < 1) continue;
    const piece = line.slice(0, cut);
    const id = Number(line.slice(cut + 1));
    if (!Number.isInteger(id)) continue;
    pieces[id] = piece;
    if (/^<[a-z]+>$/.test(piece)) special.add(id);
  }

  return new Detokenizer(pieces, special, [
    { type: 'Replace', pattern: { String: '▁' }, content: ' ' },
    { type: 'Strip', content: ' ', start: 1, stop: 0 },
  ]);
}

/** Whichever vocabulary file the model directory happens to carry. */
function loadDetokenizer(modelDir) {
  const asJson = path.join(modelDir, 'tokenizer.json');
  if (fs.existsSync(asJson)) return fromTokenizerJson(asJson);

  const asTxt = path.join(modelDir, 'vocab.txt');
  if (fs.existsSync(asTxt)) return fromVocabTxt(asTxt);

  throw new Error(
    `No tokenizer found in "${modelDir}" (expected tokenizer.json or vocab.txt). ` +
      `Remove the model in the Speech model panel and download it again.`
  );
}

module.exports = { loadDetokenizer, fromTokenizerJson, fromVocabTxt, Detokenizer };
