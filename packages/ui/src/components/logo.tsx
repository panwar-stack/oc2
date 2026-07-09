import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="24" height="24" rx="6" fill="var(--icon-strong-base)" />
      <path d="M6 7H11V17H6V7ZM8 9V15H9V9H8Z" fill="var(--background-base)" />
      <path d="M13 7H18V11H16V9H15V15H18V17H13V7Z" fill="var(--background-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="100" height="100" rx="24" fill="var(--icon-strong-base)" />
      <path d="M24 26H46V74H24V26ZM32 34V66H38V34H32Z" fill="var(--background-base)" />
      <path d="M54 26H76V46H68V34H62V66H76V74H54V26Z" fill="var(--background-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 112 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <rect y="6" width="30" height="30" rx="7" fill="var(--icon-strong-base)" />
      <path d="M7 12H13V30H7V12ZM9 15V27H11V15H9Z" fill="var(--background-base)" />
      <path d="M17 12H23V19H21V15H19V27H23V30H17V12Z" fill="var(--background-base)" />
      <path d="M40 6H64V14H48V18H64V36H40V28H56V24H40V6Z" fill="var(--icon-base)" />
      <path d="M72 6H96V14H80V18H96V36H72V28H88V24H72V6Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}
