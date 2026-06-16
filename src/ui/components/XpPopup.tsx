import { useEffect, useState, type JSX } from 'react';

interface XpPopupProps {
  xp: number;
  x: number;
  y: number;
  onDone: () => void;
}

export function XpPopup({ xp, x, y, onDone }: XpPopupProps): JSX.Element {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onDone();
    }, 1400);
    return () => clearTimeout(timer);
  }, [onDone]);

  if (!visible) return <></>;

  return (
    <div
      className="xp-popup"
      style={{ left: x, top: y }}
    >
      +{xp} XP
    </div>
  );
}
