"""users: one row per signed-in identity (Google account email)."""

from sqlalchemy import UniqueConstraint
from sqlalchemy.orm import Mapped

from vox_api.models.base import Base, CreatedAt, OptStr, Str, UuidPk


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("email", name="users_email_unique"),)

    id: Mapped[UuidPk]
    email: Mapped[Str]
    name: Mapped[OptStr]
    image: Mapped[OptStr]
    created_at: Mapped[CreatedAt]
