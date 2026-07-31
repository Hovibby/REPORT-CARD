"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";

export default function SearchBar() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const id = value.trim();

      if (!id.startsWith("C") || id.length !== 56) {
        setError("Enter a valid Stellar contract ID — starts with C, 56 characters.");
        return;
      }
      setError("");
      router.push(`/contract/${id}`);
    },
    [value, router]
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col sm:flex-row gap-2"
      role="search"
      aria-label="Look up a contract safety report"
    >
      <label htmlFor="contract-search" className="sr-only">
        Contract ID
      </label>
      <input
        id="contract-search"
        type="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError("");
        }}
        placeholder="Paste a Stellar contract ID  (C…)"
        autoComplete="off"
        spellCheck={false}
        className="flex-1 mono text-sm bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-slate-50 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500 transition"
        aria-describedby={error ? "search-error" : undefined}
        aria-invalid={Boolean(error)}
      />
      <button
        type="submit"
        className="bg-brand-600 hover:bg-brand-500 text-white font-semibold rounded-xl px-6 py-3 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 whitespace-nowrap"
      >
        Check
      </button>

      {error && (
        <p
          id="search-error"
          role="alert"
          className="sm:col-span-2 text-sm text-red-400 text-left"
        >
          {error}
        </p>
      )}
    </form>
  );
}
