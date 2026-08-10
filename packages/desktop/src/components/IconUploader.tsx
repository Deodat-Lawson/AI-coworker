import { useRef, useState } from 'react';

import { ICON_MAX_BYTES, validateIconImage } from '@ai-coworker/shared';

import { Icon } from './icons.js';

/** What an uploaded icon is squared off to. Two device pixels per rail tile. */
const SIZE = 128;

/**
 * Upload a workspace icon.
 *
 * The picture a person picks is never the picture that gets stored: it is
 * cropped square, scaled to 128px, and re-encoded before it goes anywhere. That
 * is not politeness about file size — the relay replicates this record to every
 * member, so an unbounded image would be a bandwidth bill charged to everyone
 * in the workspace for one person's screenshot. The relay checks the ceiling
 * again on arrival; this side keeps it from ever being hit.
 */
export function IconUploader({
  image,
  emoji,
  name,
  color,
  disabled,
  onImage,
}: {
  image: string;
  emoji: string;
  name: string;
  color: string;
  disabled?: boolean;
  onImage: (dataUri: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const take = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('That is not an image.');
      return;
    }
    try {
      const encoded = await squareOff(file);
      const check = validateIconImage(encoded);
      if (!check.ok) {
        setError(check.error);
        return;
      }
      onImage(encoded);
    } catch (err) {
      setError((err as Error).message || 'That image could not be read.');
    }
  };

  return (
    <div className="icon-upload">
      <div
        className={`icon-drop ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragging(false);
          void take(e.dataTransfer.files[0]);
        }}
      >
        {image ? (
          <img src={image} alt="" className="icon-preview" />
        ) : (
          <span className="icon-preview placeholder" style={{ background: color || 'var(--bg-input)' }}>
            {emoji || name.slice(0, 1).toUpperCase() || '#'}
          </span>
        )}
      </div>

      <div className="icon-upload-actions">
        <button className="tab" disabled={disabled} onClick={() => input.current?.click()}>
          <Icon name="upload" size={14} /> {image ? 'Replace image' : 'Upload image'}
        </button>
        {image ? (
          <button className="tab" disabled={disabled} onClick={() => onImage('')}>
            Remove
          </button>
        ) : null}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            void take(e.target.files?.[0]);
            // Let the same file be chosen twice in a row after a failure.
            e.target.value = '';
          }}
        />
      </div>

      <p className="hint">
        Square, {SIZE}px, under {ICON_MAX_BYTES / 1024} KB — anything larger is resized here before it
        is sent. Drop a file on the tile to replace it.
      </p>
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}

/**
 * Centre-crop to a square, scale to SIZE, encode small.
 *
 * WebP first because it is a third the size of PNG for a photograph; PNG as the
 * fallback for the rare renderer that cannot encode WebP, and because a flat
 * logo is genuinely smaller as PNG anyway.
 */
async function squareOff(file: File): Promise<string> {
  const bitmap = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This machine cannot resize images.');

  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, SIZE, SIZE);

  const webp = canvas.toDataURL('image/webp', 0.9);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/png');
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That image could not be decoded.'));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
