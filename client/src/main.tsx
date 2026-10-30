import { createRoot } from "react-dom/client";
import App from "./App";
import { installNavHistory } from "./lib/navHistory";
import "./index.css";
import "./edibell.css";

installNavHistory();
createRoot(document.getElementById("root")!).render(<App />);
