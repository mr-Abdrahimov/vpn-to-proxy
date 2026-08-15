import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Склеивает классы и разрешает конфликты Tailwind: последний выигрывает.
 * Без этого `className` снаружи компонента не может переопределить
 * его собственный padding или цвет.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
