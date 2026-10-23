// The page-change spinner:
//
//   overlay: rgba(128,128,128,0.6) with backdrop-filter: blur(10px), over everything
//   spin.js: 12 lines, length 10, width 8, radius 18, corners 1, colour #0000FF,
//            speed 1, trail 60, shadow on
//
// Every page change in the real driver passes through this — Next, Previous, a Navigator
// jump, ending a review — so it is not decoration: it is the beat between questions.
import React, { useEffect, useRef } from 'react';
import Spinner from 'spin.js';

const OPTS = {
  lines: 12, length: 10, width: 8, radius: 18, corners: 1, rotate: 0, direction: 1,
  color: '#0000FF', speed: 1, trail: 60, shadow: true, hwaccel: false,
  className: 'spinner', zIndex: 2147483400, top: '50%', left: '50%',
};

export default function SpinnerOverlay() {
  const host = useRef(null);
  useEffect(() => {
    const s = new Spinner(OPTS).spin(host.current);
    return () => s.stop();
  }, []);
  return (
    <div
      id="abe-loading-overlay"
      ref={host}
      style={{
        position: 'fixed', inset: 0, zIndex: 2147483390,
        backgroundColor: 'rgba(128, 128, 128, 0.6)',
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      }}
    />
  );
}

/** The very first load, before the driver chrome exists: "Loading, please wait…". */
export function DeliveryLoading() {
  return (
    <div id="abe-delivery-loading-overlay" style={{ visibility: 'visible' }}>
      <h1>Loading, please wait…</h1>
      <div className="sim-loading-bar" />
    </div>
  );
}
