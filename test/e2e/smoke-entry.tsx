import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import ApprovalStudio from '../../client/src/pages/ApprovalStudio/ApprovalStudio'

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/']}>
    <ApprovalStudio />
  </MemoryRouter>,
)
