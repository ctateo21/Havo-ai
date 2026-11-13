import { useEffect, useRef } from "react";
import AuthDialog from "@/components/ui/auth-dialog";
import { useAuth } from "@/context/auth-context";

interface LeadCaptureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: "share" | "save" | "new-scenario";
  address?: string;
  scenarioDetails?: string;
  onSuccess: () => void;
}

/**
 * Compatibility adapter for legacy action callers. A lead submission is not an
 * account. Never send anonymous contact information to leads/CRM endpoints.
 */
export default function LeadCaptureDialog({ open, onOpenChange, onSuccess }: LeadCaptureDialogProps) {
  const { user } = useAuth();
  const queued = useRef(false);
  const success = useRef(onSuccess);
  success.current = onSuccess;
  useEffect(() => {
    if (!user || !queued.current) return;
    queued.current = false;
    success.current();
    onOpenChange(false);
  }, [user, onOpenChange]);
  return <AuthDialog open={open} defaultTab="register" redirectAfterRegister={false}
    onAuthenticated={() => { queued.current = true; }}
    onOpenChange={next => { onOpenChange(next); }} />;
}
