import React from 'react';
import { Route, Routes } from 'react-router-dom';

import Layout from './components/Layout';
import ApprovalStudioPage from './pages/ApprovalStudio/ApprovalStudio';
import NotFound from './pages/NotFound/NotFound';

const RoutesComponent = () => {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ApprovalStudioPage />} />
        <Route path="config" element={<ApprovalStudioPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default RoutesComponent;
