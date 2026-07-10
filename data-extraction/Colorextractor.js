const HUE_BUCKET_COUNT = 12;
const HUE_BUCKET_SIZE = 360 / HUE_BUCKET_COUNT;

const MIN_ELEMENT_AREA_PX = 400;
const MIN_ALPHA_TO_COUNT = 0.05;

function parseRgba(colorString) {
  if (!colorString || colorString === 'transparent') return null;

  const match = colorString.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i
  );
  if (!match) return null;

  return {
    r: parseInt(match[1], 10),
    g: parseInt(match[2], 10),
    b: parseInt(match[3], 10),
    a: match[4] !== undefined ? parseFloat(match[4]) : 1,
  };
}

function rgbToHsl({ r, g, b }) {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h;
  switch (max) {
    case rN: h = ((gN - bN) / d + (gN < bN ? 6 : 0)); break;
    case gN: h = ((bN - rN) / d + 2); break;
    default: h = ((rN - gN) / d + 4); break;
  }
  h *= 60;

  return { h, s, l };
}

function visibleArea(el) {
  const rect = el.getBoundingClientRect();
  const viewportW = window.innerWidth || document.documentElement.clientWidth;
  const viewportH = window.innerHeight || document.documentElement.clientHeight;

  const clippedWidth = Math.max(
    0, Math.min(rect.right, viewportW) - Math.max(rect.left, 0)
  );
  const clippedHeight = Math.max(
    0, Math.min(rect.bottom, viewportH) - Math.max(rect.top, 0)
  );

  return clippedWidth * clippedHeight;
}

function buildHueHistogram(root = document.body) {
  const hueBuckets = new Array(HUE_BUCKET_COUNT).fill(0);
  let achromaticArea = 0;
  let totalArea = 0;

  const elements = root.querySelectorAll('*');

  elements.forEach(el => {
    const area = visibleArea(el);
    if (area < MIN_ELEMENT_AREA_PX) return;

    const style = window.getComputedStyle(el);
    const rgba = parseRgba(style.backgroundColor);
    if (!rgba || rgba.a < MIN_ALPHA_TO_COUNT) return;

    const { h, s, l } = rgbToHsl(rgba);
    const weightedArea = area * rgba.a;
    totalArea += weightedArea;

    const isAchromatic = s < 0.12 || l < 0.06 || l > 0.94;

    if (isAchromatic) {
      achromaticArea += weightedArea;
    } else {
      const bucketIndex = Math.floor(h / HUE_BUCKET_SIZE) % HUE_BUCKET_COUNT;
      hueBuckets[bucketIndex] += weightedArea;
    }
  });

  return { hueBuckets, achromaticArea, totalArea };
}

function extractDominantColors(root = document.body, topN = 3) {
  const { hueBuckets, achromaticArea, totalArea } = buildHueHistogram(root);

  if (totalArea === 0) {
    return {
      dominantHues: [],
      colorEnergy: 0,
      achromaticRatio: 1,
    };
  }

  const ranked = hueBuckets
    .map((area, i) => ({
      hue: Math.round(i * HUE_BUCKET_SIZE + HUE_BUCKET_SIZE / 2),
      area,
      coverage: area / totalArea,
    }))
    .filter(bucket => bucket.area > 0)
    .sort((a, b) => b.area - a.area)
    .slice(0, topN);

  const chromaticArea = totalArea - achromaticArea;
  const colorEnergy = Math.min(1, chromaticArea / totalArea);

  return {
    dominantHues: ranked,
    colorEnergy,
    achromaticRatio: achromaticArea / totalArea,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractDominantColors, rgbToHsl, parseRgba };
} else if (typeof window !== 'undefined') {
  window.Web2MusicColorExtractor = { extractDominantColors };
}
