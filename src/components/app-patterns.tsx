import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerClose,
} from '@/components/ui/drawer';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Card, CardContent } from '@/components/ui/card';
import type { Preview } from '@/types';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// Safari does not focus buttons on pointer clicks. Remember the actual opener
// without moving focus away from the composer or maintaining a custom focus trap.
let lastOpener: HTMLElement | null = null;
export function rememberOverlayOpener(event: MouseEvent<HTMLElement>) {
  const target = event.target as Element;
  lastOpener = target.closest<HTMLElement>('button, a, input, select, textarea');
}

function usePhone() {
  const [phone, setPhone] = useState(() => matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const query = matchMedia('(max-width: 767px)');
    const update = () => setPhone(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

/** Controlled overlays share focus restoration; form state stays mounted under a preview. */
export function Modal({
  title,
  close,
  children,
  inactive = false,
  drawer = false,
  informational = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  inactive?: boolean;
  drawer?: boolean;
  informational?: boolean;
}) {
  const phone = usePhone();
  const opener = useRef(
    lastOpener?.isConnected ? lastOpener : (document.activeElement as HTMLElement | null),
  );
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    if (opener.current?.isConnected) opener.current.focus();
  };
  const change = (open: boolean) => {
    if (!open && !inactive) close();
  };
  if (drawer)
    return (
      <Sheet open onOpenChange={change}>
        <SheetContent
          side="left"
          className="overflow-y-auto safe-overlay"
          onCloseAutoFocus={restoreFocus}
          aria-describedby={undefined}
        >
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">{children}</div>
        </SheetContent>
      </Sheet>
    );
  if (phone && informational)
    return (
      <Drawer open onOpenChange={change} autoFocus repositionInputs={false}>
        <DrawerContent aria-describedby={undefined} onCloseAutoFocus={restoreFocus}>
          <DrawerHeader className="relative pr-14">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerClose asChild>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1"
                aria-label="Close dialog"
              >
                <X />
              </Button>
            </DrawerClose>
          </DrawerHeader>
          <div className="overlay-body px-5 pb-6">{children}</div>
        </DrawerContent>
      </Drawer>
    );
  return (
    <Dialog open onOpenChange={change}>
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={restoreFocus}
        className="app-dialog max-md:top-auto max-md:bottom-0 max-md:translate-y-0"
        data-preview-covered={inactive || undefined}
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="overlay-body">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function Disclosure({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Collapsible className={className}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="disclosure-trigger">
          <span>{title}</span>
          <ChevronDown className="transition-transform in-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function TaskCollection({
  value,
  onValueChange,
  children,
}: {
  value: 'mine' | 'household' | 'all';
  onValueChange: (value: 'mine' | 'household' | 'all') => void;
  children: ReactNode;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onValueChange(next as typeof value)}>
      <TabsList aria-label="Task view" className="h-auto">
        {(['mine', 'household', 'all'] as const).map((filter) => (
          <TabsTrigger className="min-h-11" key={filter} value={filter}>
            {filter === 'mine' ? 'For me' : filter === 'household' ? 'Household' : 'Everything'}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={value} className="mt-3">
        {children}
      </TabsContent>
    </Tabs>
  );
}

export function ConfirmationDetails({
  preview,
  format,
}: {
  preview: Preview;
  format: (value: string, label: string) => string;
}) {
  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardContent className="divide-y px-0">
        {preview.details.map((detail, index) => (
          <div className="preview-detail" key={index}>
            <span>{detail.label}</span>
            <p>
              {detail.before !== undefined && detail.before !== detail.after && (
                <del>{format(detail.before, detail.label)}</del>
              )}
              <strong>{format(detail.after, detail.label)}</strong>
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
