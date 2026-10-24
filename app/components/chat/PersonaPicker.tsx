/**
 * PersonaPicker (agentrove-inspired).
 *
 * Compact dropdown next to the chat mode selector: pick the persona whose
 * custom instructions shape this chat. Ships with a professional built-in
 * roster (Fullstack, Designer, DevOps, …) and supports custom personas
 * created inline. The selected persona travels with the chat request payload
 * and is injected into the system prompt by the chat worker.
 */

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { memo, useCallback, useState } from 'react';
import { savePersona, usePersonas, type Persona } from '~/lib/stores/personas';
import { classNames } from '~/utils/classNames';

function PersonaRow({ persona, active, onSelect }: { persona: Persona; active: boolean; onSelect: () => void }) {
  const { deletePersona: remove } = usePersonas();

  return (
    <DropdownMenu.Item
      className={classNames(
        'group flex items-center gap-2.5 px-3 py-2 rounded-md text-sm cursor-pointer',
        'text-bolt-elements-textPrimary',
        'hover:bg-bolt-elements-item-backgroundActive',
        'focus:outline-none',
        active && 'bg-bolt-elements-item-backgroundAccent',
      )}
      onSelect={onSelect}
    >
      <div
        className={classNames(
          'w-7 h-7 shrink-0 rounded-md flex items-center justify-center',
          active ? 'bg-bolt-elements-item-backgroundAccent/60' : 'bg-bolt-elements-item-backgroundDefault',
        )}
      >
        <div className={classNames(persona.icon || 'i-ph:user-circle', 'text-lg')} />
      </div>
      <div className="flex flex-col flex-1 min-w-0">
        <span className="truncate font-medium">{persona.name}</span>
        <span className="text-xs text-bolt-elements-textSecondary truncate">
          {persona.tagline || persona.instructions}
        </span>
      </div>
      {persona.builtIn ? (
        <span className="text-[10px] uppercase tracking-wide text-bolt-elements-textTertiary border border-bolt-elements-borderColor rounded px-1 py-0.5">
          Built-in
        </span>
      ) : (
        <button
          type="button"
          title="Delete persona"
          className="opacity-0 group-hover:opacity-100 transition-opacity text-bolt-elements-textTertiary hover:text-bolt-elements-icon-error"
          onClick={(event) => {
            event.stopPropagation();
            remove(persona.id);
          }}
        >
          <div className="i-ph:trash text-sm" />
        </button>
      )}
    </DropdownMenu.Item>
  );
}

export const PersonaPicker = memo(() => {
  const { builtInPersonas, customPersonas, activePersona, setActivePersona } = usePersonas();
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');

  const handleSave = useCallback(() => {
    if (!name.trim() || !instructions.trim()) {
      return;
    }

    const persona = savePersona({ name, instructions });
    setActivePersona(persona.id);

    setName('');
    setInstructions('');
    setIsCreating(false);
  }, [name, instructions, setActivePersona]);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title={activePersona ? `Persona: ${activePersona.name}` : 'Select a persona'}
          className={classNames(
            'transition-all flex items-center gap-1 rounded-md px-1.5 py-1 text-xs',
            activePersona
              ? 'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
              : 'bg-bolt-elements-item-backgroundDefault text-bolt-elements-item-contentDefault hover:bg-bolt-elements-item-backgroundActive',
          )}
        >
          <div className={activePersona?.icon || 'i-ph:user-circle'} />
          <span className="hidden sm:inline max-w-[110px] truncate">
            {activePersona ? activePersona.name : 'Persona'}
          </span>
          <div className="i-ph:caret-down text-sm" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={classNames(
            'min-w-[300px] max-h-[420px] overflow-y-auto rounded-lg p-1',
            'bg-bolt-elements-background-depth-2',
            'border border-bolt-elements-borderColor',
            'shadow-lg',
            'z-50',
          )}
          sideOffset={5}
          align="start"
        >
          <DropdownMenu.Item
            className={classNames(
              'flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer',
              'text-bolt-elements-textPrimary',
              'hover:bg-bolt-elements-item-backgroundActive',
              'focus:outline-none',
              !activePersona && 'bg-bolt-elements-item-backgroundAccent',
            )}
            onSelect={() => setActivePersona(null)}
          >
            <div className="w-7 h-7 shrink-0 rounded-md flex items-center justify-center bg-bolt-elements-item-backgroundDefault">
              <div className="i-ph:circle text-lg" />
            </div>
            <span>No persona</span>
          </DropdownMenu.Item>

          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-bolt-elements-textTertiary">
            Built-in roles
          </div>

          {builtInPersonas.map((persona) => (
            <PersonaRow
              key={persona.id}
              persona={persona}
              active={activePersona?.id === persona.id}
              onSelect={() => setActivePersona(persona.id)}
            />
          ))}

          {customPersonas.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-bolt-elements-borderColor" />
              <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-bolt-elements-textTertiary">
                Custom
              </div>

              {customPersonas.map((persona) => (
                <PersonaRow
                  key={persona.id}
                  persona={persona}
                  active={activePersona?.id === persona.id}
                  onSelect={() => setActivePersona(persona.id)}
                />
              ))}
            </>
          )}

          <DropdownMenu.Separator className="my-1 h-px bg-bolt-elements-borderColor" />

          {isCreating ? (
            <div className="p-2 space-y-2">
              <input
                type="text"
                autoFocus
                value={name}
                placeholder="Persona name"
                className="w-full px-2 py-1.5 rounded-md text-sm bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor text-bolt-elements-textPrimary focus:outline-none focus:ring-1 focus:ring-bolt-elements-focus"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setIsCreating(false);
                  }
                }}
              />
              <textarea
                value={instructions}
                placeholder="Custom instructions for this persona…"
                rows={4}
                className="w-full px-2 py-1.5 rounded-md text-sm bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor text-bolt-elements-textPrimary focus:outline-none focus:ring-1 focus:ring-bolt-elements-focus resize-none"
                onChange={(event) => setInstructions(event.target.value)}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  className="flex-1 px-2 py-1.5 rounded-md text-xs bg-purple-500/10 text-purple-500 hover:bg-purple-500/20"
                >
                  Save persona
                </button>
                <button
                  type="button"
                  onClick={() => setIsCreating(false)}
                  className="px-2 py-1.5 rounded-md text-xs bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-4"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <DropdownMenu.Item
              className={classNames(
                'flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer',
                'text-bolt-elements-textSecondary',
                'hover:bg-bolt-elements-item-backgroundActive',
                'focus:outline-none',
              )}
              onSelect={(event) => {
                event.preventDefault();
                setIsCreating(true);
              }}
            >
              <div className="w-7 h-7 shrink-0 rounded-md flex items-center justify-center bg-bolt-elements-item-backgroundDefault">
                <div className="i-ph:plus text-lg" />
              </div>
              <span>New persona</span>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
});

PersonaPicker.displayName = 'PersonaPicker';
