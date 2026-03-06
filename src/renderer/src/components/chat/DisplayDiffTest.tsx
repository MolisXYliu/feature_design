import { DiffDisplay } from "./ToolCallRenderer";

const mock = `diff --git a/src/components/UserProfile.tsx b/src/components/UserProfile.tsx
index abc1234..def5678 100644
--- a/src/components/UserProfile.tsx
+++ b/src/components/UserProfile.tsx
@@ -1,10 +1,15 @@
 import React from 'react'
+import { useState } from 'react'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'

 interface UserProfileProps {
   name: string
-  email: string
+  email?: string
+  avatar?: string
 }

-export function UserProfile({ name, email }: UserProfileProps) {
+export function UserProfile({ name, email, avatar }: UserProfileProps) {
+  const [isFollowing, setIsFollowing] = useState(false)
+
   return (
     <div className="user-profile">
-      <h2>{name}</h2>
-      <p>{email}</p>
+      <div className="flex items-center gap-4">
+        <img src={avatar || '/default-avatar.png'} alt={name} className="w-12 h-12 rounded-full" />
+        <div>
+          <h2 className="text-xl font-semibold">{name}</h2>
+          {email && <p className="text-gray-600">{email}</p>}
+        </div>
+        <Button onClick={() => setIsFollowing(!isFollowing)} variant={isFollowing ? "outline" : "default"}>
+          {isFollowing ? 'Following' : 'Follow'}
+        </Button>
+      </div>
     </div>
   )
 }`
export default function DisplayDiffTest() {
  return    <DiffDisplay diff={mock} />
}
