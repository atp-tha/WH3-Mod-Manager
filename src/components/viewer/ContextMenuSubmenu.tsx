import React, { useState, type ReactNode } from "react";

export type ContextMenuSubmenuProps = {
  label: ReactNode;
  children: ReactNode;
};

const ContextMenuSubmenu = ({ label, children }: ContextMenuSubmenuProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
      onFocus={() => setIsOpen(true)}
    >
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className="w-full text-left px-4 py-2 hover:bg-gray-700 text-white text-sm flex items-center justify-between gap-4"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <span>{label}</span>
        <span aria-hidden="true">▶</span>
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute left-full top-0 z-50 min-w-[250px] max-w-[340px] bg-gray-800 border border-gray-600 rounded shadow-lg p-1"
        >
          {children}
        </div>
      )}
    </div>
  );
};

export default ContextMenuSubmenu;
