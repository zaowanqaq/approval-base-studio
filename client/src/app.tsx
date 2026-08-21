import React from 'react';
import { Route, Routes } from 'react-router-dom';

import Layout from './components/Layout';
import NotFound from './pages/NotFound/NotFound';
import PaymentConsole from './pages/PaymentConsole/PaymentConsole';
import PluginConfigPage from './pages/PluginConfig/PluginConfig';

const RoutesComponent = () => {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<PaymentConsole />} />
        <Route path="config" element={<PluginConfigPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default RoutesComponent;
