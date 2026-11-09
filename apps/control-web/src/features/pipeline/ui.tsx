import type { ReactNode } from 'react';

export const Muted = ({ children }: { children: ReactNode }) => <span className="text-muted">{children}</span>;
export const Note = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted">{children}</p>;
