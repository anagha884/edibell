import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SessionProvider } from "./auth/session";
import { Protected } from "./components/Portal";
import { HomePage, WhyFoodRescuePage } from "./pages/PublicPages";
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from "./pages/AuthPages";
import { CreateDonationPage, DonorDashboard, DonorDonationsPage, DonorRequestsPage, DonorScannerPage, EditListingPage } from "./pages/DonorPages";
import { FinderPage, HistoryPage, MyRequestsPage, PickupQrPage, RecipientDashboard } from "./pages/RecipientPages";
import { ImpactPage, NotificationsPage, ProfilePage } from "./pages/SharedPages";
import { AdminPage } from "./pages/AdminPages";
import { LanguageProvider, tr } from "./i18n";

/**
 * Three isolated portals. The route guard is a convenience only: every read
 * and write is authorized again by the database (RLS + role-checked functions).
 * Routes render elements (not component factories) so that re-rendering the
 * app — e.g. after a language change — never remounts the current page.
 */

function Router() {
  return <Switch>
    <Route path="/" component={HomePage}/>
    <Route path="/why-food-rescue" component={WhyFoodRescuePage}/>
    <Route path="/login" component={LoginPage}/>
    <Route path="/register" component={RegisterPage}/>
    <Route path="/forgot-password" component={ForgotPasswordPage}/>
    <Route path="/reset-password" component={ResetPasswordPage}/>

    <Route path="/donor"><Protected role="donor"><DonorDashboard/></Protected></Route>
    <Route path="/donor/create"><Protected role="donor"><CreateDonationPage/></Protected></Route>
    <Route path="/donor/listings/:id/edit"><Protected role="donor"><EditListingPage/></Protected></Route>
    <Route path="/donor/requests"><Protected role="donor"><DonorRequestsPage/></Protected></Route>
    <Route path="/donor/donations"><Protected role="donor"><DonorDonationsPage/></Protected></Route>
    <Route path="/donor/scanner"><Protected role="donor"><DonorScannerPage/></Protected></Route>
    <Route path="/donor/notifications"><Protected role="donor"><NotificationsPage/></Protected></Route>
    <Route path="/donor/impact"><Protected role="donor"><ImpactPage/></Protected></Route>
    <Route path="/donor/profile"><Protected role="donor"><ProfilePage/></Protected></Route>

    <Route path="/ngo"><Protected role="ngo"><RecipientDashboard role="ngo"/></Protected></Route>
    <Route path="/ngo/finder"><Protected role="ngo"><FinderPage role="ngo"/></Protected></Route>
    <Route path="/ngo/requests"><Protected role="ngo"><MyRequestsPage role="ngo"/></Protected></Route>
    <Route path="/ngo/pickup"><Protected role="ngo"><PickupQrPage role="ngo"/></Protected></Route>
    <Route path="/ngo/history"><Protected role="ngo"><HistoryPage role="ngo"/></Protected></Route>
    <Route path="/ngo/notifications"><Protected role="ngo"><NotificationsPage/></Protected></Route>
    <Route path="/ngo/impact"><Protected role="ngo"><ImpactPage/></Protected></Route>
    <Route path="/ngo/profile"><Protected role="ngo"><ProfilePage/></Protected></Route>

    <Route path="/animal"><Protected role="animal"><RecipientDashboard role="animal"/></Protected></Route>
    <Route path="/animal/finder"><Protected role="animal"><FinderPage role="animal"/></Protected></Route>
    <Route path="/animal/requests"><Protected role="animal"><MyRequestsPage role="animal"/></Protected></Route>
    <Route path="/animal/pickup"><Protected role="animal"><PickupQrPage role="animal"/></Protected></Route>
    <Route path="/animal/history"><Protected role="animal"><HistoryPage role="animal"/></Protected></Route>
    <Route path="/animal/notifications"><Protected role="animal"><NotificationsPage/></Protected></Route>
    <Route path="/animal/impact"><Protected role="animal"><ImpactPage/></Protected></Route>
    <Route path="/animal/profile"><Protected role="animal"><ProfilePage/></Protected></Route>
    <Route path="/animal/needs"><Redirect to="/animal/profile"/></Route>

    <Route path="/admin"><Protected adminOnly><AdminPage/></Protected></Route>

    <Route path="/404" component={NotFound}/>
    <Route component={NotFound}/>
  </Switch>;
}

export default function App() {
  return <ErrorBoundary><LanguageProvider>{() => <ThemeProvider defaultTheme="light"><TooltipProvider><SessionProvider><Toaster containerAriaLabel={tr("Notifications")}/><Router/></SessionProvider></TooltipProvider></ThemeProvider>}</LanguageProvider></ErrorBoundary>;
}
