// Copyright (C) 2026 HidayahTech, LLC
export function Breadcrumb({ prefix, onNavigate }) {
  if (!prefix) return (
    <div class="breadcrumb"><span class="current">/ (root)</span></div>
  );
  const parts = prefix.split('/').filter(Boolean);
  return (
    <div class="breadcrumb">
      <span class="crumb" onClick={() => onNavigate('')}>root</span>
      {parts.map((part, i) => {
        const target = parts.slice(0, i + 1).join('/') + '/';
        const isLast = i === parts.length - 1;
        return [
          <span key={`sep-${i}`} class="sep">/</span>,
          isLast
            ? <span key={part} class="current">{part}</span>
            : <span key={part} class="crumb" onClick={() => onNavigate(target)}>{part}</span>,
        ];
      })}
    </div>
  );
}
