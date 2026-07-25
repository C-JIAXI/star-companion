import { ChevronDown, ChevronRight } from "lucide-react";
import { usePlaceholderSrc } from "../placeholderImages";

interface ChatGroupHeaderProps {
  characterId: string;
  characterAvatar: string | null;
  characterName: string;
  chatCount: number;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}

export function ChatGroupHeader({
  characterId,
  characterAvatar,
  characterName,
  chatCount,
  isExpanded,
  onToggle
}: ChatGroupHeaderProps) {
  const src = usePlaceholderSrc(characterAvatar, characterId);

  return (
    <button
      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-white/[0.04]"
      type="button"
      onClick={() => onToggle(characterId)}
    >
      {isExpanded ? (
        <ChevronDown size={14} className="shrink-0 text-slate-500" />
      ) : (
        <ChevronRight size={14} className="shrink-0 text-slate-500" />
      )}
      <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-md border border-white/[0.08] bg-ink-800">
        <img
          alt=""
          className="h-full w-full object-cover"
          src={src}
        />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-slate-200">
        {characterName}
      </span>
      <span className="shrink-0 rounded bg-white/[0.05] px-1.5 py-0.5 text-xs tabular-nums text-slate-500">
        {chatCount}
      </span>
    </button>
  );
}
