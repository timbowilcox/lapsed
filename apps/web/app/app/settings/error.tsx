"use client";

import { DataError } from "../_components/data-error";

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <DataError error={error} reset={reset} />;
}
