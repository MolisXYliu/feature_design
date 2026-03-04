import React from "react"
import { DiffDisplay } from "./ToolCallRenderer"

// Mock git diff output for testing
const mockDiff = `diff --git a/src/components/App.tsx b/src/components/App.tsx
index 1234567..abcdef0 100644
--- a/src/components/App.tsx
+++ b/src/components/App.tsx
@@ -1,10 +1,12 @@
 import React, { useState } from 'react'
+import { Button } from './ui/button'
 import { Header } from './Header'
 import { Sidebar } from './Sidebar'

 function App() {
   const [count, setCount] = useState(0)
+  const [theme, setTheme] = useState('light')

   return (
     <div className="app">
-      <Header />
+      <Header theme={theme} />
       <Sidebar />
       <main>
         <h1>Hello World</h1>
@@ -15,6 +17,9 @@ function App() {
         </button>
       </main>
     </div>
   )
 }

-export default App
+export default App
+
+// New feature: Theme toggle
+function ThemeToggle({ theme, onToggle }: { theme: string, onToggle: () => void }) {
+  return <Button onClick={onToggle}>Toggle {theme}</Button>
+}`

export function DiffTest(): React.JSX.Element {
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold">Git Diff Display Test</h2>
      <div className="border rounded-lg p-4">
        <h3 className="text-sm font-medium mb-2">Mock Git Diff Output:</h3>
        <DiffDisplay diff={mockDiff} />
      </div>
    </div>
  )
}
