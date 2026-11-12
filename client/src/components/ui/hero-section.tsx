import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Search, LayoutDashboard, LogIn } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import AuthDialog from "@/components/ui/auth-dialog";
import { useGooglePlaces } from "@/hooks/use-google-places";

function LoginOrDashboardButton() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);

  if (user) {
    return (
      <Button
        variant="outline"
        className="bg-white/10 border-white/30 text-white hover:bg-white/20 hover:text-white gap-2"
        onClick={() => setLocation("/dashboard")}
      >
        <LayoutDashboard className="h-4 w-4" />
        Go to My Dashboard
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        className="bg-white/10 border-white/30 text-white hover:bg-white/20 hover:text-white gap-2"
        onClick={() => setOpen(true)}
      >
        <LogIn className="h-4 w-4" />
        Log In / Create Account
      </Button>
      <AuthDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export default function HeroSection() {
  const [, setLocation] = useLocation();
  const { bindInputRef, inputRef } = useGooglePlaces({
    onPlaceSelected: place => {
      setLocation(`/select-service?address=${encodeURIComponent(place.formatted_address)}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const val = inputRef.current?.value?.trim();
    if (!val) return;
    setLocation(`/select-service?address=${encodeURIComponent(val)}`);
  };

  return (
    <section className="relative min-h-[100vh] flex items-center justify-center">
      <div className="absolute inset-0 bg-gradient-to-br from-primary via-primary/90 to-primary/70">
        <div className="absolute inset-0 bg-black/30" />
      </div>

      <div className="relative z-10 w-full max-w-2xl mx-auto px-4 text-center">
        <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-4 leading-tight">
          <span className="block">100% Free</span>
          See the real cost of any Florida home — before you sign anything
        </h1>
        <p className="text-lg md:text-xl text-white/80 mb-10">
          Type any Florida address and get the true monthly cost in seconds — mortgage, property taxes, insurance, and flood. Free, instant, and no sign-up or personal info needed to see your first home.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3 max-w-xl mx-auto">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground z-10 pointer-events-none" />
            <input
              ref={bindInputRef}
              type="text"
              placeholder="Enter a property address..."
              className="w-full pl-10 pr-4 h-14 text-base rounded-xl bg-white border-0 shadow-lg outline-none focus:ring-2 focus:ring-secondary"
            />
          </div>
          <Button
            type="submit"
            size="lg"
            className="h-14 px-8 rounded-xl bg-secondary hover:bg-secondary/90 text-white font-semibold text-base shadow-lg"
          >
            Get Estimate
          </Button>
        </form>

        <div className="mt-8 border-t border-white/20 pt-6">
          <p className="text-white/60 text-sm mb-3">Already have an account?</p>
          <LoginOrDashboardButton />
        </div>
      </div>
    </section>
  );
}
