import Link from 'next/link';

/**
 * One 404 page for the whole app. It says as little as it can: "this store does not exist" and
 * "this product is not yours" arrive here by the same route, and telling them apart would be the
 * enumeration leak S1 is about.
 */
export default function NotFound() {
  return (
    <div className="sf-shell">
      <main className="sf-main">
        <div className="sf-page-header">
          <h1>Not found</h1>
          <p className="sf-muted">There is nothing here.</p>
        </div>
        <Link className="sf-button sf-button-quiet" href="/">
          Start again
        </Link>
      </main>
    </div>
  );
}
