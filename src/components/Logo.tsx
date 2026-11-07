import React from 'react';
import inkMask from '../assets/logo/ink.png';
import dotMask from '../assets/logo/dot.png';

interface LogoProps {
  size?: number;
  className?: string;
  /** Seal dot color; defaults to the theme accent. */
  accent?: string;
  title?: string;
}

const layer = (mask: string, color: string): React.CSSProperties => ({
  position: 'absolute',
  inset: 0,
  backgroundColor: color,
  WebkitMaskImage: `url(${mask})`,
  maskImage: `url(${mask})`,
  WebkitMaskSize: 'contain',
  maskSize: 'contain',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
  maskPosition: 'center',
});

/**
 * ZenPDF mark: a brush-stroke "Z" inside an open ensō with a vermilion seal.
 * The artwork is split into two alpha masks so the ink follows `currentColor`
 * (readable in light and dark themes) while the seal keeps the accent color.
 */
export const Logo: React.FC<LogoProps> = ({ size = 28, className, accent = 'var(--accent)', title = 'ZenPDF' }) => (
  <span
    role="img"
    aria-label={title}
    className={className}
    style={{ position: 'relative', display: 'inline-block', width: size, height: size, flexShrink: 0 }}
  >
    <span style={layer(inkMask, 'currentColor')} />
    <span style={layer(dotMask, accent)} />
  </span>
);
