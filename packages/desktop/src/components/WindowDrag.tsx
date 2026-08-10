/**
 * The strip that moves the window.
 *
 * The window has no title bar — on macOS `titleBarStyle: 'hiddenInset'` hides it
 * and leaves the traffic lights floating over our own chrome, which is what lets
 * the sidebar run all the way to the top edge. What it does not do is give you
 * anywhere to grab: a frameless window is only draggable where the page says
 * `-webkit-app-region: drag`, and nothing said it. So the app could be moved by
 * the couple of dead pixels beside the traffic lights and nowhere else, which is
 * exactly the "dragging this around is impossible" the window earned.
 *
 * One element, spanning the full width of the top band, fixes it everywhere at
 * once — including the sign-in and onboarding screens, which is why this is
 * mounted beside the app rather than inside it.
 *
 * It sits *over* the content, so the band has to stay clear of anything you
 * click. Every view already leaves `--titlebar-h` of room at the top for the
 * traffic lights, and this is the same height, so "keep the top band empty" is
 * one rule serving both. Anything that does need to live up there marks itself
 * `-webkit-app-region: no-drag` and keeps working.
 *
 * Double-clicking it zooms the window, the way double-clicking a title bar does;
 * macOS gives us that for free once the region exists.
 */
export default function WindowDrag() {
  return <div className="window-drag" aria-hidden="true" />;
}
