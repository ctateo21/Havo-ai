import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Menu, Home, Briefcase, ChevronDown,
  LayoutDashboard, LogIn, LogOut, User, Settings as SettingsIcon,
  Key, Banknote, RefreshCw, Shield, Tag, GraduationCap, BarChart2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/context/auth-context";
import AuthDialog from "@/components/ui/auth-dialog";
import havoLogo from "@assets/havo-logo.png";

const TEAM_EMAILS = new Set([
  "christian@tateoco.com",
  "omar@tateoco.com",
  "kyle@tateoco.com",
  "alex@tateoco.com",
  "courtney@tateoco.com",
]);

export default function Header() {
  const [isOpen, setIsOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();

  const isTeamMember = Boolean(user && TEAM_EMAILS.has((user.email ?? "").toLowerCase()));

  const SERVICES = [
    { label: "Purchase with Loan", tabId: "purchase",  serviceType: "purchase",  icon: Key },
    { label: "Purchase with Cash", tabId: "cash_buy",  serviceType: "cash_buy",  icon: Banknote },
    { label: "Refinance",          tabId: "refinance", serviceType: "refinance", icon: RefreshCw },
    { label: "Insurance",          tabId: "insurance", serviceType: "insurance", icon: Shield },
    { label: "Sell Your Home",     tabId: "sellers",   serviceType: "seller",    icon: Tag },
  ] as const;

  function handleServiceClick(svc: typeof SERVICES[number]) {
    setIsOpen(false);
    if (user) {
      setLocation(`/dashboard?tab=${svc.tabId}`);
    } else {
      setLocation(`/?service=${svc.serviceType}`);
    }
  }

  const links = [
    { href: "/", label: "HOME", icon: <Home className="mr-2 h-4 w-4" /> },
    {
      href: "/#services",
      label: "SERVICES",
      icon: <Briefcase className="mr-2 h-4 w-4" />,
      hasDropdown: true,
      dropdownItems: SERVICES.map(s => ({ label: s.label, onClick: () => handleServiceClick(s) })),
    },
    { href: "/education", label: "EDUCATION", icon: <GraduationCap className="mr-2 h-4 w-4" /> },
    ...(isTeamMember
      ? [{ href: "/leaderboard", label: "LEADERBOARD", icon: <BarChart2 className="mr-2 h-4 w-4" /> }]
      : []),
  ];

  async function handleLogout() {
    await logout();
    setLocation("/");
    setIsOpen(false);
  }

  const initials = user
    ? user.name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2)
    : "";

  return (
    <header className="bg-white shadow-sm sticky top-0 z-50">
      {/* Top Bar */}
      <div className="bg-primary py-2 text-white">
        <div className="container mx-auto px-4 flex justify-between items-center">
          <div className="text-sm hidden md:block">
            <span>(813) 214-8356</span>
          </div>
          <div className="flex items-center space-x-4">
            <a href="mailto:sales@havofl.com" className="text-white hover:text-white/80 text-sm">
              sales@havofl.com
            </a>
            <span className="hidden" aria-hidden="true">
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path fillRule="evenodd" d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z" clipRule="evenodd" />
              </svg>
            </span>
            <span className="hidden" aria-hidden="true">
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8.29 20.251c7.547 0 11.675-6.253 11.675-11.675 0-.178 0-.355-.012-.53A8.348 8.348 0 0022 5.92a8.19 8.19 0 01-2.357.646 4.118 4.118 0 001.804-2.27 8.224 8.224 0 01-2.605.996 4.107 4.107 0 00-6.993 3.743 11.65 11.65 0 01-8.457-4.287 4.106 4.106 0 001.27 5.477A4.072 4.072 0 012.8 9.713v.052a4.105 4.105 0 003.292 4.022 4.095 4.095 0 01-1.853.07 4.108 4.108 0 003.834 2.85A8.233 8.233 0 012 18.407a11.616 11.616 0 006.29 1.84" />
              </svg>
            </span>
          </div>
        </div>
      </div>

      {/* Main Navigation */}
      <div className="container mx-auto px-4 py-4 flex justify-between items-center">
        <div className="flex items-center">
          <Link href={user ? "/dashboard" : "/"} className="flex items-center">
            <img src={havoLogo} alt="Havo" className="h-10 w-auto" />
          </Link>
        </div>

        {/* Desktop Navigation */}
        <nav className="hidden md:flex items-center space-x-6">
          {links.map((link) => (
            link.hasDropdown ? (
              <DropdownMenu key={link.label}>
                <DropdownMenuTrigger className="text-gray-700 hover:text-primary font-medium text-sm uppercase tracking-wide py-2 focus:outline-none flex items-center">
                  {link.label} <ChevronDown className="ml-1 h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" className="w-56">
                  {link.dropdownItems?.map((item) => (
                    <DropdownMenuItem
                      key={item.label}
                      onClick={item.onClick}
                      className="cursor-pointer"
                    >
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Link
                key={link.label}
                href={link.href}
                className="text-gray-700 hover:text-primary font-medium text-sm uppercase tracking-wide py-2"
              >
                {link.label}
              </Link>
            )
          ))}

          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-full focus:outline-none">
                  <div className="h-8 w-8 rounded-full bg-primary text-white flex items-center justify-center font-bold text-xs">
                    {initials}
                  </div>
                  <span className="text-sm font-medium text-gray-700 hidden lg:block">{user.name.split(" ")[0]}</span>
                  <ChevronDown className="h-4 w-4 text-gray-500" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem asChild>
                  <Link href="/dashboard" className="w-full cursor-pointer flex items-center gap-2">
                    <LayoutDashboard className="h-4 w-4" /> My Dashboard
                  </Link>
                </DropdownMenuItem>
                {isTeamMember && (
                  <DropdownMenuItem asChild>
                    <Link href="/leaderboard" className="w-full cursor-pointer flex items-center gap-2">
                      <BarChart2 className="h-4 w-4" /> Team Leaderboard
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  <Link href="/settings" className="w-full cursor-pointer flex items-center gap-2">
                    <SettingsIcon className="h-4 w-4" /> Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive cursor-pointer flex items-center gap-2">
                  <LogOut className="h-4 w-4" /> Log Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setAuthOpen(true)}
            >
              <LogIn className="h-4 w-4" /> Log In
            </Button>
          )}
        </nav>

        {/* Mobile Menu */}
        <Sheet open={isOpen} onOpenChange={setIsOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="md:hidden">
              <Menu className="h-6 w-6" />
              <span className="sr-only">Toggle menu</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-[300px] sm:w-[400px]">
            <div className="flex items-center mb-6">
              <img src={havoLogo} alt="Havo" className="h-10 w-auto" />
            </div>

            {user && (
              <div className="flex items-center gap-3 mb-6 pb-6 border-b">
                <div className="h-9 w-9 rounded-full bg-primary text-white flex items-center justify-center font-bold text-sm shrink-0">
                  {initials}
                </div>
                <div>
                  <p className="font-semibold text-sm">{user.name}</p>
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                </div>
              </div>
            )}

            <nav className="flex flex-col space-y-6">
              {links.map((link) => (
                <div key={link.label}>
                  {link.hasDropdown ? (
                    <>
                      <div className="flex items-center text-lg font-medium text-gray-700 mb-2">
                        {link.icon}{link.label}
                      </div>
                      <div className="ml-8 space-y-3">
                        {link.dropdownItems?.map((item) => (
                          <button
                            key={item.label}
                            type="button"
                            onClick={item.onClick}
                            className="block text-left text-gray-600 hover:text-primary w-full"
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <Link
                      href={link.href}
                      className="flex items-center text-lg font-medium text-gray-700"
                      onClick={() => setIsOpen(false)}
                    >
                      {link.icon}{link.label}
                    </Link>
                  )}
                </div>
              ))}

              {user ? (
                <>
                  <Link
                    href="/dashboard"
                    className="flex items-center text-lg font-medium text-gray-700 gap-2"
                    onClick={() => setIsOpen(false)}
                  >
                    <LayoutDashboard className="h-5 w-5 mr-1" /> My Dashboard
                  </Link>
                  {isTeamMember && (
                    <Link
                      href="/leaderboard"
                      className="flex items-center text-lg font-medium text-gray-700 gap-2"
                      onClick={() => setIsOpen(false)}
                    >
                      <BarChart2 className="h-5 w-5 mr-1" /> Team Leaderboard
                    </Link>
                  )}
                  <Link
                    href="/settings"
                    className="flex items-center text-lg font-medium text-gray-700 gap-2"
                    onClick={() => setIsOpen(false)}
                  >
                    <SettingsIcon className="h-5 w-5 mr-1" /> Settings
                  </Link>
                  <button
                    onClick={handleLogout}
                    className="flex items-center text-lg font-medium text-destructive gap-2 text-left"
                  >
                    <LogOut className="h-5 w-5 mr-1" /> Log Out
                  </button>
                </>
              ) : (
                <button
                  onClick={() => { setIsOpen(false); setAuthOpen(true); }}
                  className="flex items-center text-lg font-medium text-gray-700 gap-2"
                >
                  <LogIn className="h-5 w-5 mr-1" /> Log In
                </button>
              )}
            </nav>
          </SheetContent>
        </Sheet>
      </div>

      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} />
    </header>
  );
}
