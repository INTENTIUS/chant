@id("allow-alice-read")
permit (
  principal == App::User::"alice",
  action == App::Action::"read",
  resource is App::Document
);
