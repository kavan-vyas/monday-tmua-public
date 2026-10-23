// Is he actually here? Shared by every clock that writes seconds to the record (Do
// backlog, the paper flow). A clock that kept running through a doorbell would mark a
// question he knew as slow, permanently and silently — so time only counts while the
// window has focus, or while Monday is talking (he is listening, not away), or in EXAM
// mode, which is a timed sitting by definition.
import { useEffect, useState } from 'react';
import { audio } from './audio.js';

export function useAttention(mode) {
  const [focused, setFocused] = useState(() => typeof document === 'undefined' || (document.hasFocus() && !document.hidden));
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    const sync = () => setFocused(document.hasFocus() && !document.hidden);
    window.addEventListener('blur', sync);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      window.removeEventListener('blur', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);
  useEffect(() => {
    setSpeaking(audio.speaking);
    return audio.onChange((a) => setSpeaking(a.speaking));
  }, []);
  return focused || speaking || mode === 'EXAM';
}
