import * as React from 'react'
import { cn } from '@renderer/lib/utils'
import { Switch as SwitchPrimitive } from 'radix-ui'

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-[20px] w-[34px] shrink-0 cursor-pointer items-center rounded-full border border-transparent outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[var(--text)] data-[state=unchecked]:bg-black/15',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-[16px] rounded-full bg-white shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-[15px] data-[state=unchecked]:translate-x-[1px]'
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
