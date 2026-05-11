import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import History from './pages/History'
import ReportBuilder from './pages/ReportBuilder'
import Upload from './pages/Upload'
import Uploads from './pages/Uploads'

function NavBar() {
  return (
    <nav className="nav">
      <span className="nav-brand">
        <span>Zones</span> · Cloud Health Portal
      </span>
      <NavLink to="/" end className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        Dashboard
      </NavLink>
      <NavLink to="/upload" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        Upload
      </NavLink>
      <NavLink to="/report" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        Report Builder
      </NavLink>
      <NavLink to="/history" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        History
      </NavLink>
      <NavLink to="/uploads" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
        Manage Uploads
      </NavLink>
    </nav>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <NavBar />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/upload" element={<Upload />} />
        <Route path="/report" element={<ReportBuilder />} />
        <Route path="/history" element={<History />} />
        <Route path="/uploads" element={<Uploads />} />
      </Routes>
    </BrowserRouter>
  )
}
