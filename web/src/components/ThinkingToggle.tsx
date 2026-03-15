import { memo, useEffect, useRef, useState } from 'react';

interface ThinkingToggleProps {
  enabled: boolean;
  budgetTokens: number;
  effort?: string;
  model?: string;
  onToggle: (enabled: boolean, budgetTokens: number, effort?: string) => void;
  disabled?: boolean;
}

export const BUDGET_OPTIONS = [
  { value: 5000, label: '5K' },
  { value: 10000, label: '10K' },
  { value: 20000, label: '20K' },
  { value: 50000, label: '50K' },
  { value: 100000, label: '100K' },
];

export const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

export const isAdvancedModel = (model?: string) =>
  model === 'claude-opus-4-6' || model === 'claude-sonnet-4-6';

export const ThinkingToggle = memo(function ThinkingToggle({
  enabled,
  budgetTokens,
  effort = 'high',
  model,
  onToggle,
  disabled = false,
}: ThinkingToggleProps) {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleToggle = () => {
    if (disabled) return;
    onToggle(!enabled, budgetTokens, effort);
  };

  const useEffort = isAdvancedModel(model);

  const handleBudgetSelect = (value: number) => {
    onToggle(enabled, value, effort);
    setShowMenu(false);
  };

  const handleEffortSelect = (value: string) => {
    onToggle(enabled, budgetTokens, value);
    setShowMenu(false);
  };

  const currentBudgetLabel =
    BUDGET_OPTIONS.find((o) => o.value === budgetTokens)?.label ||
    `${Math.round(budgetTokens / 1000)}K`;
  const currentEffortLabel = EFFORT_OPTIONS.find((o) => o.value === effort)?.label || 'High';

  return (
    <div className='relative flex items-center gap-1.5' ref={menuRef}>
      <button
        onClick={handleToggle}
        disabled={disabled}
        className={`w-9 h-9 flex items-center justify-center rounded-lg text-sm font-medium transition-colors duration-150 ${
          enabled
            ? 'bg-iris-thinking/20 text-iris-thinking hover:bg-iris-thinking/30'
            : 'bg-iris-surface text-iris-text-secondary hover:bg-iris-surface-raised border border-iris-border'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        title={
          enabled
            ? 'Extended thinking enabled - click to disable'
            : 'Enable extended thinking for deeper reasoning'
        }
        aria-label={enabled ? 'Disable extended thinking' : 'Enable extended thinking'}
      >
        <svg className='w-5 h-5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
          <path
            strokeLinecap='round'
            strokeLinejoin='round'
            strokeWidth={1.5}
            d='M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z'
          />
        </svg>
      </button>

      {enabled && (
        <button
          onClick={() => setShowMenu(!showMenu)}
          disabled={disabled}
          className={`px-2.5 py-1.5 rounded-lg text-sm font-mono bg-iris-surface text-iris-text-secondary hover:bg-iris-surface-raised transition-colors duration-150 ${
            disabled ? 'opacity-50 cursor-not-allowed' : ''
          }`}
          title={useEffort ? 'Thinking effort level' : 'Thinking budget (tokens)'}
          aria-label={useEffort ? 'Thinking effort level' : 'Thinking budget'}
        >
          {useEffort ? currentEffortLabel : currentBudgetLabel}
          <svg
            className='w-3.5 h-3.5 ml-1 inline'
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth={1.5}
              d='M19 9l-7 7-7-7'
            />
          </svg>
        </button>
      )}

      {showMenu && (
        <div className='absolute bottom-full right-0 mb-1 bg-iris-surface rounded-lg shadow-float ring-1 ring-white/[0.06] border border-iris-border py-1.5 z-50 min-w-[90px]'>
          {useEffort
            ? EFFORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleEffortSelect(option.value)}
                  className={`w-full px-4 py-2 text-left text-sm font-mono hover:bg-iris-surface-raised transition-colors duration-150 ${
                    option.value === effort
                      ? 'text-iris-thinking bg-iris-thinking/10'
                      : 'text-iris-text'
                  }`}
                >
                  {option.label}
                </button>
              ))
            : BUDGET_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleBudgetSelect(option.value)}
                  className={`w-full px-4 py-2 text-left text-sm font-mono hover:bg-iris-surface-raised transition-colors duration-150 ${
                    option.value === budgetTokens
                      ? 'text-iris-thinking bg-iris-thinking/10'
                      : 'text-iris-text'
                  }`}
                >
                  {option.label}
                </button>
              ))}
        </div>
      )}
    </div>
  );
});
