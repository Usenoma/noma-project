import { redirect } from "next/navigation";

/** The wallet index moved to the buyer vault, which also holds device keys. */
export default function OrdersIndex() {
  redirect("/orders");
}
