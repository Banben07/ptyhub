import { toast } from '../state.ts';

export function Toast() {
  const current = toast.value;
  if (!current) return null;
  return (
    <div class={`toast ${current.kind}`} role="status">
      {current.text}
    </div>
  );
}
