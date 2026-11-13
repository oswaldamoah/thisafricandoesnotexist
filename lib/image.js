// Post-processing: crop watermark strips, square-crop, resize, encode WebP, tag as AI-generated.
import sharp from 'sharp';

const SIZE = Number(process.env.OUTPUT_SIZE || 1024);

export async function finishImage(bytes, { cropBottom = 0 } = {}) {
  const img = sharp(bytes, { failOn: 'error' });
  const meta = await img.metadata();
  if (!meta.width || !meta.height || meta.width < 256 || meta.height < 256) {
    throw new Error(`image too small or unreadable (${meta.width}x${meta.height})`);
  }

  // 1. cut the bottom strip (Pollinations / Zhipu watermark)
  const cut = Math.round(meta.height * cropBottom);
  const h = meta.height - cut;
  // 2. square-crop inside the kept area, biased to the top (faces sit in the upper half)
  //    — one extract from the original, so the cut strip can never come back in.
  const side = Math.min(meta.width, h);
  const left = Math.floor((meta.width - side) / 2);
  const top = h > side ? Math.floor((h - side) * 0.3) : 0;
  const square = await sharp(bytes).extract({ left, top, width: side, height: side }).toBuffer();

  // 3. reject blank / error images (flat colour = rate-limit placeholder, black frame, etc.)
  const stats = await sharp(square).stats();
  const spread = stats.channels.slice(0, 3).reduce((s, c) => s + c.stdev, 0) / 3;
  if (spread < 12) throw new Error(`image looks blank (stdev ${spread.toFixed(1)})`);

  // 4. resize + encode, with EXIF saying what it is
  const webp = await sharp(square)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .withExif({ IFD0: { ImageDescription: 'AI-generated portrait. This person does not exist.', Software: 'thisafricandoesnotexist' } })
    .webp({ quality: 88 })
    .toBuffer();

  const thumb = await sharp(square).resize(512, 512).jpeg({ quality: 80 }).toBuffer(); // for the vision QA model
  return { webp, thumb };
}
