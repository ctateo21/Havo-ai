import Agents from "./pages/agents";
import AgentsResults from "./pages/agents-results";
import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServicesProvider } from "./context/services-context";
import { AuthProvider } from "./context/auth-context";

function ScrollToTop() {
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location]);
  return null;
}

import Header from "./components/layout/header";
import Footer from "./components/layout/footer";
import Home from "./pages/home";
import Education from "./pages/education";
import Dashboard from "./pages/dashboard";
import Settings from "./pages/settings";
import Insurance from "./pages/insurance";
import Estimate from "./pages/estimate";
import Refinance from "./pages/refinance";
import SellerEstimate from "./pages/seller-estimate";
import CashBuy from "./pages/cash-buy";
import ResetPassword from "./pages/reset-password";
import SelectService from "./pages/select-service";
import Subscribe from "./pages/subscribe";
import SubscribeSuccess from "./pages/subscribe-success";
import ProtectedRoute from "./components/protected-route";
import ToolGate from "./components/tool-gate";
import NotFound from "./pages/not-found";
import Leaderboard from "./pages/leaderboard";
import Terms from "./pages/legal/terms";
import Privacy from "./pages/legal/privacy";
import FairHousing from "./pages/legal/fair-housing";
import SmsTerms from "./pages/legal/sms-terms";
import Accessibility from "./pages/legal/accessibility";
import FlInsuranceCost from "./pages/aeo/florida-insurance-cost";
import FlFloodZones from "./pages/aeo/florida-flood-zones";
import FlClosingCosts from "./pages/aeo/florida-closing-costs";
import FlPropertyTax from "./pages/aeo/florida-property-tax";
import FlMortgageGuide from "./pages/aeo/florida-mortgage-guide";

function SitemapRedirect() {
  useEffect(() => {
    window.location.replace("/sitemap.xml");
  }, []);
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <ServicesProvider>
            <ScrollToTop />
            <Switch>
              <Route>
                <div className="flex flex-col min-h-screen">
                  <Header />
                  <main className="flex-grow">
                    <Switch>
                      <Route path="/" component={Home} />
                      <Route path="/education" component={Education} />
                      <Route path="/settings" component={Settings} />
                      <Route path="/subscribe" component={Subscribe} />
                      <Route path="/subscribe/success" component={SubscribeSuccess} />
                      <Route path="/dashboard">
                        <ProtectedRoute><Dashboard /></ProtectedRoute>
                      </Route>
                      <Route path="/insurance">
                        <ToolGate><Insurance /></ToolGate>
                      </Route>
                      <Route path="/estimate">
                        <ToolGate><Estimate /></ToolGate>
                      </Route>
                      <Route path="/refinance">
                        <ToolGate><Refinance /></ToolGate>
                      </Route>
                      <Route path="/seller">
                        <ToolGate><SellerEstimate /></ToolGate>
                      </Route>
                      <Route path="/cash-buy">
                        <ToolGate><CashBuy /></ToolGate>
                      </Route>
                      <Route path="/reset-password" component={ResetPassword} />
                      <Route path="/select-service" component={SelectService} />
                      <Route path="/leaderboard">
                        <ProtectedRoute><Leaderboard /></ProtectedRoute>
                      </Route>
                      <Route path="/terms" component={Terms} />
                      <Route path="/privacy" component={Privacy} />
                      <Route path="/fair-housing" component={FairHousing} />
                      <Route path="/sms-terms" component={SmsTerms} />
                      <Route path="/accessibility" component={Accessibility} />
                      <Route path="/florida-homeowners-insurance-cost" component={FlInsuranceCost} />
                      <Route path="/florida-flood-zones-explained" component={FlFloodZones} />
                      <Route path="/florida-real-estate-closing-costs" component={FlClosingCosts} />
                      <Route path="/florida-property-tax-calculator" component={FlPropertyTax} />
                      <Route path="/mortgage-payment-calculator-florida" component={FlMortgageGuide} />
                      <Route path="/sitemap" component={SitemapRedirect} />
                      <Route path="/agents" component={Agents} />
                      <Route path="/admin/agents" component={AgentsResults} />
                      <Route component={NotFound} />
                    </Switch>
                  </main>
                  <Footer />
                </div>
              </Route>
            </Switch>
            <Toaster />
          </ServicesProvider>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
