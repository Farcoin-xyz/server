CREATE TABLE mint (
  id int not null auto_increment primary key,
  liker_fid int not null,
  liked_fid int not null,
  liker_address varchar(42) not null,
  liked_address varchar(42) not null,
  quantity_likes int not null,
  first_like_time int not null,
  last_like_time int not null,
  block_timestamp int not null,
  block_number int not null,
  transaction_hash varchar(66) not null,

  index liker (liker_fid),
  index liked (liked_fid),
  index mint_time (block_timestamp),
  unique key mint_compound_key (liked_fid, first_like_time)
);

CREATE TABLE claim (
  id int not null auto_increment primary key,
  liker_fid int not null,
  liker_address varchar(42) not null,
  nonce int not null,
  quantity_tokens decimal(13,2) not null,
  block_timestamp int not null,
  block_number int not null,
  transaction_hash varchar(66) not null,

  index claimer (liker_fid),
  index claim_time (block_timestamp),
  unique key claim_compound_key (liker_fid, nonce)
);

CREATE TABLE log_scan (
  id int not null auto_increment primary key,
  log_type varchar(10) not null unique,
  last_block_number int not null
);
