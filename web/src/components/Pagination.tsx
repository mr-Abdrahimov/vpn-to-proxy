import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button, Select } from './ui';

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200] as const;
/** Псевдоразмер «показать все»: удобнее, чем отдельный флаг. */
export const PAGE_SIZE_ALL = -1;

const STORAGE_KEY = 'vtp-page-size';

export interface PaginationState<T> {
  page: number;
  pageSize: number;
  pageCount: number;
  items: T[];
  total: number;
  from: number;
  to: number;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
}

/**
 * Пагинация на клиенте: список нод приходит целиком (их сотни, не десятки
 * тысяч), поэтому резать его на сервере смысла нет, а мгновенная смена
 * страницы и размера — заметно приятнее.
 *
 * Выбранный размер страницы запоминается: это настройка рабочего места,
 * и сбрасывать её при каждом заходе неправильно.
 */
export function usePagination<T>(allItems: T[], storageKey = STORAGE_KEY): PaginationState<T> {
  const [pageSize, setPageSizeState] = useState<number>(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return PAGE_SIZE_OPTIONS.includes(stored as (typeof PAGE_SIZE_OPTIONS)[number]) || stored === PAGE_SIZE_ALL
      ? stored
      : 25;
  });
  const [page, setPage] = useState(0);

  const total = allItems.length;
  const effectiveSize = pageSize === PAGE_SIZE_ALL ? Math.max(total, 1) : pageSize;
  const pageCount = Math.max(1, Math.ceil(total / effectiveSize));

  // Список мог сократиться (фильтр, удаление) — не оставляем пользователя
  // на несуществующей странице с пустым экраном.
  useEffect(() => {
    if (page > pageCount - 1) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  const currentPage = Math.min(page, pageCount - 1);

  const items = useMemo(
    () => allItems.slice(currentPage * effectiveSize, currentPage * effectiveSize + effectiveSize),
    [allItems, currentPage, effectiveSize],
  );

  const setPageSize = (size: number) => {
    setPageSizeState(size);
    localStorage.setItem(storageKey, String(size));
    setPage(0);
  };

  return {
    page: currentPage,
    pageSize,
    pageCount,
    items,
    total,
    from: total === 0 ? 0 : currentPage * effectiveSize + 1,
    to: Math.min(total, (currentPage + 1) * effectiveSize),
    setPage,
    setPageSize,
  };
}

export function Pagination<T>({
  state,
  itemLabel = 'записей',
  className,
}: {
  state: PaginationState<T>;
  itemLabel?: string;
  className?: string;
}) {
  const { page, pageCount, total, from, to, setPage, setPageSize, pageSize } = state;

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <p className="text-sm text-muted-foreground">
        {total === 0 ? (
          `Нет ${itemLabel}`
        ) : (
          <>
            Показано <span className="font-medium text-foreground">{from}</span>–
            <span className="font-medium text-foreground">{to}</span> из{' '}
            <span className="font-medium text-foreground">{total}</span> {itemLabel}
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          На странице
          <Select
            size="sm"
            className="w-24"
            aria-label="Количество записей на странице"
            value={String(pageSize)}
            onValueChange={(value) => setPageSize(Number(value))}
            items={[
              ...PAGE_SIZE_OPTIONS.map((size) => ({ value: String(size), label: String(size) })),
              { value: String(PAGE_SIZE_ALL), label: 'все' },
            ]}
          />
        </label>

        {pageCount > 1 ? (
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" disabled={page === 0} onClick={() => setPage(0)} title="В начало">
              <ChevronsLeft className="size-4" />
            </Button>
            <Button size="icon" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} title="Назад">
              <ChevronLeft className="size-4" />
            </Button>

            {buildPageList(page, pageCount).map((entry, index) =>
              entry === null ? (
                <span key={`gap-${index}`} className="px-1 text-sm text-muted-foreground">
                  …
                </span>
              ) : (
                <Button
                  key={entry}
                  size="icon"
                  variant={entry === page ? 'primary' : 'ghost'}
                  onClick={() => setPage(entry)}
                  aria-current={entry === page ? 'page' : undefined}
                >
                  {entry + 1}
                </Button>
              ),
            )}

            <Button
              size="icon"
              variant="ghost"
              disabled={page >= pageCount - 1}
              onClick={() => setPage(page + 1)}
              title="Вперёд"
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              disabled={page >= pageCount - 1}
              onClick={() => setPage(pageCount - 1)}
              title="В конец"
            >
              <ChevronsRight className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Номера страниц с многоточиями: всегда видны первая, последняя и соседи
 * текущей. null означает разрыв.
 */
function buildPageList(current: number, count: number): (number | null)[] {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index);

  const pages = new Set<number>([0, count - 1, current]);
  for (const offset of [-1, 1]) {
    const neighbour = current + offset;
    if (neighbour > 0 && neighbour < count - 1) pages.add(neighbour);
  }
  // У краёв показываем чуть больше соседей, чтобы блок не «прыгал» по ширине.
  if (current <= 2) [1, 2, 3].forEach((page) => page < count - 1 && pages.add(page));
  if (current >= count - 3) [count - 4, count - 3, count - 2].forEach((page) => page > 0 && pages.add(page));

  const sorted = [...pages].sort((a, b) => a - b);
  const result: (number | null)[] = [];

  sorted.forEach((page, index) => {
    const previous = sorted[index - 1];
    if (previous !== undefined && page - previous > 1) result.push(null);
    result.push(page);
  });

  return result;
}
