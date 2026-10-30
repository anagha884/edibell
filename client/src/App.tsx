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
import type { ReactNode } from "react";
import type { Role } from "@shared/edibell";

/**
 * Three isolated portals. The route guard is a convenience only: every read
 * and write is authorized again by the database (RLS + role-checked functions).
 */
const page = (role: Role, node: ReactNode) => () => <Protected role={role}>{node}</Protected>;

function Router() {
  return <Switch>
    <Route path="/" component={HomePage}/>
    <Route path="/why-food-rescue" component={WhyFoodRescuePage}/>
    <Route path="/login" component={LoginPage}/>
    <Route path="/register" component={RegisterPage}/>
    <Route path="/forgot-password" component={ForgotPasswordPage}/>
    <Route path="/reset-password" component={ResetPasswordPage}/>

    <Route path="/donor" component={page("donor", <DonorDashboard/>)}/>
    <Route path="/donor/create" component={page("donor", <CreateDonationPage/>)}/>
    <Route path="/donor/listings/:id/edit" component={page("donor", <EditListingPage/>)}/>
    <Route path="/donor/requests" component={page("donor", <DonorRequestsPage/>)}/>
    <Route path="/donor/donations" component={page("donor", <DonorDonationsPage/>)}/>
    <Route path="/donor/scanner" component={page("donor", <DonorScannerPage/>)}/>
    <Route path="/donor/notifications" component={page("donor", <NotificationsPage/>)}/>
    <Route path="/donor/impact" component={page("donor", <ImpactPage/>)}/>
    <Route path="/donor/profile" component={page("donor", <ProfilePage/>)}/>

    <Route path="/ngo" component={page("ngo", <RecipientDashboard role="ngo"/>)}/>
    <Route path="/ngo/finder" component={page("ngo", <FinderPage role="ngo"/>)}/>
    <Route path="/ngo/requests" component={page("ngo", <MyRequestsPage role="ngo"/>)}/>
    <Route path="/ngo/pickup" component={page("ngo", <PickupQrPage role="ngo"/>)}/>
    <Route path="/ngo/history" component={page("ngo", <HistoryPage role="ngo"/>)}/>
    <Route path="/ngo/notifications" component={page("ngo", <NotificationsPage/>)}/>
    <Route path="/ngo/impact" component={page("ngo", <ImpactPage/>)}/>
    <Route path="/ngo/profile" component={page("ngo", <ProfilePage/>)}/>

    <Route path="/animal" component={page("animal", <RecipientDashboard role="animal"/>)}/>
    <Route path="/animal/finder" component={page("animal", <FinderPage role="animal"/>)}/>
    <Route path="/animal/requests" component={page("animal", <MyRequestsPage role="animal"/>)}/>
    <Route path="/animal/pickup" component={page("animal", <PickupQrPage role="animal"/>)}/>
    <Route path="/animal/history" component={page("animal", <HistoryPage role="animal"/>)}/>
    <Route path="/animal/notifications" component={page("animal", <NotificationsPage/>)}/>
    <Route path="/animal/impact" component={page("animal", <ImpactPage/>)}/>
    <Route path="/animal/profile" component={page("animal", <ProfilePage/>)}/>
    <Route path="/animal/needs"><Redirect to="/animal/profile"/></Route>

    <Route path="/admin" component={() => <Protected adminOnly><AdminPage/></Protected>}/>

    <Route path="/404" component={NotFound}/>
    <Route component={NotFound}/>
  </Switch>;
}

export default function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="light"><TooltipProvider><SessionProvider><Toaster/><Router/></SessionProvider></TooltipProvider></ThemeProvider></ErrorBoundary>;
}
